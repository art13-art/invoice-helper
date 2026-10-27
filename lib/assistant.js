// LINE 群組助理：群組裡每個人都能用。不碰任何人的帳本或個人財務資料。
// Claude 負責理解與回答；工具負責讀群組紀錄做總結、待辦、提醒，
// 以及廠商群組的記帳（寫進該群組綁定的雲端試算表，按確認才寫入）。
import { toBlocks } from "./files.js";
import { BOOK_TOOLS, runBookTool, gas } from "./books.js";
import { recordAI, checkBudget, buildReport, budgetUSD } from "./usage.js";
import { findTranscripts } from "./audio.js";
import { adminFor, decisionCard, newDecision, toAdmin } from "./escalate.js";
import { lineClient } from "./line.js";

const HOUR = 3600e3, DAY = 24 * HOUR;
export const KEEP_DAYS = 30;                  // 群組訊息紀錄保留天數

/* ---------- 台北時間 ---------- */
export const tp = (ms = Date.now()) => new Date(ms + 8 * HOUR);
export const ymd = (ms = Date.now()) => tp(ms).toISOString().slice(0, 10);
export const hm = ms => tp(ms).toISOString().slice(11, 16);
const WEEK = "日一二三四五六";
export const md = s => { const [, m, d] = s.split("-").map(Number); return `${m}/${d}`; };
export const mdw = ms => { const t = tp(ms); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WEEK[t.getUTCDay()]}）`; };
export const when = ms => `${mdw(ms)} ${hm(ms)}`;
/* "2026-10-27T14:00" 或 "2026-10-27"（台北）→ epoch ms；只有日期時預設 09:00 */
export function parseLocal(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 9), +(m[5] ?? 0)) - 8 * HOUR;
}
export const rid = (n = 8) => crypto.randomUUID().replace(/-/g, "").slice(0, n);

/* 自動排的提醒避開深夜：落在 22:00–08:00 就延到早上 8:00（對方明確指定的時間不套用） */
export function quiet(ms) {
  const t = new Date(ms + 8 * 3600e3), h = t.getUTCHours();
  if (h >= 8 && h < 22) return ms;
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + (h >= 22 ? 1 : 0), 8, 0) - 8 * 3600e3;
}
/* 待辦的提醒：前一天 16:00 先提醒一次、到期時再提醒（之後每天 9:00 追到按「已完成」，在 tick 裡） */
export async function scheduleTodo(db, { todoId, chatId, task, due, aid, aname, by }) {
  if (!due) return;
  const now = Date.now(), d = new Date(due + 8 * 3600e3);
  const eve = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 16, 0) - 8 * 3600e3;
  const ins = (at, text) => db.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status) VALUES(?,?,?,?,'none',?,?,?,?,?,'open')")
    .bind(rid(6), chatId, at, text, aid || null, aname || null, todoId, now, by || null).run();
  if (eve > now && eve < due) await ins(eve, "明天到期：" + task);
  if (due > now) await ins(due, "待辦到期：" + task);
}
export const isGroup = chatId => /^[CR]/.test(chatId || "");

/* ---------- 資料表 ---------- */
export const kv = {
  get: async (db, k) => (await db.prepare("SELECT v FROM line_kv WHERE k=?").bind(k).first())?.v ?? null,
  set: (db, k, v) => db.prepare("INSERT INTO line_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(),
  json: async (db, k, d) => { try { return JSON.parse(await kv.get(db, k)) ?? d; } catch (e) { return d; } },
};

/* 記住群組成員的顯示名稱（一週更新一次），回傳 { name, optout } */
export async function member(db, line, chatId, userId) {
  if (!userId) return { name: "某位成員", optout: 0 };
  const row = await db.prepare("SELECT name,optout,updated FROM line_members WHERE chat_id=? AND user_id=?").bind(chatId, userId).first();
  if (row && Date.now() - row.updated < 7 * DAY && row.name) return row;
  const name = (await line.name(chatId, userId).catch(() => null)) || row?.name || "成員";
  await db.prepare("INSERT INTO line_members(chat_id,user_id,name,optout,updated) VALUES(?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET name=excluded.name, updated=excluded.updated")
    .bind(chatId, userId, name, row?.optout || 0, Date.now()).run();
  return { name, optout: row?.optout || 0 };
}

/* ---------- 工具 ---------- */
const REPEAT = ["none", "daily", "weekdays", "weekly", "monthly"];
const MEMORY_TOOLS = [
  { name: "remember", description: "記住別人教你的事（規則、偏好、固定做法）。管理員教的所有群組都適用；其他人教的只用在這個聊天室，不確定能不能記的會 @管理員 用按鈕決定。如果跟已記住的某條是同一件事，傳 replaces 取代那一條，不要重複新增。",
    input_schema: { type: "object", properties: { text: { type: "string", description: "要記住的內容，寫成一句清楚完整的話" }, replaces: { type: "string", description: "要取代的舊記憶編號（同一件事時）" },
      sure: { type: "boolean", description: "非管理員教的才看：只影響他自己或這個群組日常做法、無害的（例如稱呼、回覆格式、慣用說法）填 true；會影響別人、牽涉金錢帳務或個資、要所有群組都套用、跟已記住的規則衝突、或改變你的基本做法（不記錄、不提醒、替人做決定）填 false" },
      reason: { type: "string", description: "sure=false 時，一句話說為什麼要管理員決定" } }, required: ["text"] } },
  { name: "forget", description: "刪掉一條記住的事（用編號）。非管理員只能刪這個聊天室的；所有群組通用的會轉給管理員按鈕決定。", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];
const DEEP_RE = /(詳細|深入|完整|仔細)(的)?(分析|說明|研究|報告|比較|規劃|企劃)|仔細想|想清楚|好好想|認真想|做成(報告|文件)|整理成(報告|文件)|寫成(報告|文件)/;
const RESEARCH_RE = /競品|競爭對手|市場|趨勢|研究|調查|政策|規範|審核|查一下|查查/;
const REPORT_TOOL = { name: "save_report", description: "把長的分析、報告、企劃、比較表存成 Google 文件，回傳連結。對方說「做成報告／文件」或內容太長、有表格時用。content 用簡單格式：「# 」大標、「## 」小標、「- 」條列、表格用「| 欄 | 欄 |」。",
  input_schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } };
const ASK_ADMIN = { name: "ask_admin", description: "需要管理員處理或決定、你自己做不到的事（權限、設定、費用、出錯、你判斷不了的決定），直接 @管理員（他不在這裡就私訊他）。text 寫清楚是誰、要什麼、為什麼，像同事轉達一樣。",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
export async function memories(db, chatId) {
  const { results } = await db.prepare("SELECT id,text,chat_id FROM line_memory WHERE chat_id IS NULL OR chat_id=? ORDER BY updated LIMIT 80").bind(chatId || "").all();
  return results;
}
/* 轉給管理員：訊息先放在 ctx.adminMsgs，回覆時一起送出（在群組就 @他，不在就私訊） */
async function escalate(ctx, text, card) {
  const { env, db, chatId } = ctx;
  ctx.adm = ctx.adm !== undefined ? ctx.adm : await adminFor(env, db, chatId);
  if (!ctx.adm) return { how: "none" };
  const r = await toAdmin(env, db, { chatId, chatName: ctx.chatName, adm: ctx.adm, text, card });
  (ctx.adminMsgs ||= []).push(...r.msgs);
  return { how: r.how, admin: ctx.adm.name };
}
const told = (r) => r.how === "here" ? `已經在這裡 @${r.admin} 了` : r.how === "dm" ? `已經私訊 ${r.admin} 了` : "目前沒有設定管理員";
/* 會改變資料的工具：完成後在對話紀錄留一行，避免之後重做 */
const WRITE_TOOLS = {
  set_reminder: (i, r) => `設定提醒 ${r.when} ${i.text}`,
  add_todos: (i, r) => "新增待辦 " + (r.added || []).map(t => t.task).join("、"),
  complete_todos: (i, r) => "劃掉待辦 " + (r.done || []).join("、"),
  cancel_reminder: i => "取消提醒 " + i.id,
  update_reminder: (i, r) => `改提醒 ${i.id} → ${r.when || ""} ${r.text || ""}`,
  update_todo: (i, r) => `改待辦 ${i.id}` + (r.due ? ` 期限 ${r.due}` : "") + (r.assignee ? ` 負責 ${r.assignee}` : ""),
  remember: (i, r) => r.pending ? "等待決定（已轉達）：記住 " + i.text : "記住 " + i.text,
  forget: (i, r) => r.pending ? "等待決定（已轉達）：刪除記憶" : "刪除記憶",
  ask_admin: i => "轉告管理員：" + String(i.text).slice(0, 60),
  save_report: (i, r) => `存成文件「${i.title}」${r.url ? " " + r.url : ""}`,
  propose_rows: () => "列出待確認的帳",
};
const COST_TOOL = { name: "assistant_cost", description: "查小助理自己的使用費用（AI token 費用、回覆次數、LINE 主動訊息），只有管理員能用。",
  input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM，預設本月" } } } };
export const TOOLS = [
  { name: "read_chat", description: "讀這個群組最近的聊天紀錄（做總結、找誰說過什麼、整理待辦時用）。只有群組裡能用。",
    input_schema: { type: "object", properties: { hours: { type: "integer", description: "往回幾小時，預設 24，最多 720" } } } },
  { name: "search_chat", description: "用關鍵字找這個群組以前說過的話（最近 30 天的原始訊息＋一年內的每日重點摘要）。有人問「上週說的那個」「之前誰提過…」「那次決定什麼」時用。",
    input_schema: { type: "object", properties: { keyword: { type: "string", description: "要找的字，可用空白分開多個（都要出現）" },
      from: { type: "string", description: "從哪天開始 YYYY-MM-DD，可省略" }, to: { type: "string", description: "到哪天 YYYY-MM-DD，可省略" } } } },
  { name: "view_media", description: "看這個聊天室最近傳的照片、截圖或檔案（PDF、Excel、Word、PowerPoint、CSV）。有人說「這張」「剛傳的檔案」「截圖裡」或要你看圖、讀檔案時用。", input_schema: { type: "object", properties: {
    kind: { type: "string", enum: ["any", "image", "file"], description: "要看照片還是檔案，預設 any" },
    keyword: { type: "string", description: "檔名或傳的人的名字，可省略" },
    count: { type: "integer", minimum: 1, maximum: 3, description: "要看幾個，預設 1（最新的）" } } } },
  { name: "read_transcript", description: "讀這個聊天室之前轉好的錄音逐字稿（最近 30 天）。有人問會議或錄音裡誰說了什麼、決定了什麼、要再整理一次時用。不給 keyword 就是最近一份；說話者 A、B 是自動分辨的代號。",
    input_schema: { type: "object", properties: { keyword: { type: "string", description: "要找的關鍵字（人名、主題），可省略" }, list: { type: "boolean", description: "true 只列出有哪些逐字稿，不讀內容" } } } },
  { name: "list_members", description: "列出這個聊天室已知的成員名稱（要 @ 人或指派待辦時用）。", input_schema: { type: "object", properties: {} } },
  { name: "add_todos", description: "把待辦加入這個聊天室的待辦清單。有期限的會在期限當天提醒，並 @ 負責人。有人交辦事情時使用。",
    input_schema: { type: "object", properties: { items: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: {
      task: { type: "string" }, assignee: { type: "string", description: "負責人名稱（用成員名稱），沒有就省略" },
      due: { type: "string", description: "期限，台北時間 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，沒有就省略" } }, required: ["task"] } } }, required: ["items"] } },
  { name: "list_todos", description: "列出這個聊天室的待辦。", input_schema: { type: "object", properties: { include_done: { type: "boolean" } } } },
  { name: "complete_todos", description: "把待辦標成完成（用 list_todos 的編號）。", input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
  { name: "set_reminder", description: "設定提醒。target=here 發在目前聊天室，target=me 私訊提醒發問的人（對方要先加助理好友）。",
    input_schema: { type: "object", properties: { when: { type: "string", description: "台北時間 YYYY-MM-DDTHH:mm" }, text: { type: "string" },
      repeat: { type: "string", enum: REPEAT }, target: { type: "string", enum: ["here", "me"] },
      mention: { type: "string", description: "要 @ 誰：成員名稱，多人用「、」分隔；「我」＝發問的人；「全部」＝@All（全體要注意的事、公告、開會）。群組裡一定要填，沒說是誰就填「我」" },
      group: { type: "string", description: "要發到別的群組時填群組名稱（例如在私訊裡排程到某個群組）；發在目前聊天室就不填" },
      kind: { type: "string", enum: ["reminder", "message"], description: "reminder＝提醒（前面加⏰）；message＝到時間直接代發一則訊息（例如公告、通知），內容照 text 原文" },
      auto: { type: "boolean", description: "提醒時間是你自己推算的（例如會議前一天 18:00、前 30 分鐘），不是對方指定的，就填 true：落在 22:00–08:00 會自動延到早上 8 點" } }, required: ["when", "text"] } },
  { name: "update_reminder", description: "修改還沒到的提醒（用 list_reminders 的編號）：改時間、延後、改內容、改重複、改要 @ 的人。「改到 3 點」「延後一天」「改成每週」都用這個，不要取消再重設。",
    input_schema: { type: "object", properties: { id: { type: "string" }, when: { type: "string", description: "新的台北時間 YYYY-MM-DDTHH:mm" }, text: { type: "string" },
      repeat: { type: "string", enum: REPEAT }, mention: { type: "string", description: "要 @ 誰：成員名稱，多人用「、」分隔；「我」＝發問的人；「全部」＝@All" } }, required: ["id"] } },
  { name: "update_todo", description: "修改待辦（用 list_todos 的編號）：改內容、改負責人、改期限或延期。期限改了，到期提醒會跟著改。",
    input_schema: { type: "object", properties: { id: { type: "string" }, task: { type: "string" }, assignee: { type: "string" }, due: { type: "string", description: "新期限 YYYY-MM-DDTHH:mm；「無」代表取消期限" } }, required: ["id"] } },
  { name: "list_reminders", description: "列出這個聊天室和發問者自己還沒到的提醒。", input_schema: { type: "object", properties: {} } },
  { name: "cancel_reminder", description: "取消提醒（用 list_reminders 的編號）。", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

/* 訂單流程狀態（只有在流程相關的群組或管理員可用） */
export const ORDER_TOOL = { name: "order_status", description: "查自動訂單流程最近處理的訂單：哪些已經送給廠商（幾點）、哪些還在等資料補齊。有人叫你轉單、問訂單送了沒時先查這個；已送過的不要再送。", input_schema: { type: "object", properties: { keyword: { type: "string", description: "姓名、電話或地址關鍵字，可省略" } } } };
const ORDER_STATE = { seen: "還沒送（資料未齊或剛填好，約 1 分鐘內會自動送）", alerted: "還沒送：資料缺漏，已提醒補齊", sending: "正在送", done: "已送給廠商", upd: "已送給廠商，資料有修改，約 1 分鐘內會送更新", updating: "正在送更新" };
async function orderStatus(ctx, input) {
  const flows = ctx.flows || [];
  if (!flows.length) return { error: "這個群組沒有設定自動訂單流程" };
  const kw = String(input.keyword || "").trim(), out = [];
  for (const f of flows) {
    const { results } = await ctx.db.prepare("SELECT * FROM line_flow_rows WHERE flow=? ORDER BY ts DESC LIMIT 50").bind(f.id).all();
    const fields = f.fields || f.required;
    for (const r of results) {
      let v = []; try { v = JSON.parse(r.hash); } catch (e) {}
      const data = Object.fromEntries(fields.map((k, i) => [k, v[i] || ""]));
      if (kw && !JSON.stringify(data).includes(kw)) continue;
      const missing = f.required.filter(k => !data[k]);
      const nm = data[f.required[0]] || `第 ${r.row} 列`;
      const reply = ["done"].includes(r.status) ? `${nm}的單已填表且轉告廠商。`
        : ["upd", "updating"].includes(r.status) ? `${nm}的單已填表且轉告廠商，修改的資料 1 分鐘內會更新。`
        : missing.length ? `${nm}的單還缺${missing.join("、")}，補齊後會自動轉給廠商。` : `${nm}的單 1 分鐘內會轉給廠商。`;
      out.push({ 回覆: reply, 流程: f.name || f.id, 來源列: r.row, ...data, 狀態: ORDER_STATE[r.status] || r.status, ...(missing.length ? { 缺: missing.join("、") } : {}),
        ...(["done", "upd", "updating"].includes(r.status) ? { 廠商表列: r.dst_row, 最後處理: when(r.ts), 廠商: r.acked ? "已回覆確認" : "還沒回覆" } : {}) });
      if (out.length >= 20) break;
    }
  }
  return { orders: out };
}

async function viewMedia(ctx, input) {
  const kind = input.kind || "any", n = Math.min(Math.max(Number(input.count) || 1, 1), 3), kw = String(input.keyword || "").trim();
  const { results } = await ctx.db.prepare("SELECT media,name,text,ts FROM line_msgs WHERE chat_id=? AND media IS NOT NULL AND ts>? ORDER BY id DESC LIMIT 40").bind(ctx.chatId, Date.now() - 14 * DAY).all();
  const pick = results.filter(r => (kind === "any" || (kind === "file") === r.media.startsWith("file:")) && (!kw || r.text.includes(kw) || (r.name || "").includes(kw))).slice(0, n);
  if (!pick.length) return { error: "最近兩週沒有找到符合的照片或檔案" };
  const blocks = [];
  for (const r of pick) {
    const file = r.media.startsWith("file:"), id = file ? r.media.slice(5) : r.media;
    const fname = file ? (r.text.match(/檔案：(.*)］/) || [])[1] || "" : "照片.jpg";
    blocks.push({ type: "text", text: `${r.name} 在 ${when(r.ts)} 傳的${file ? "檔案「" + fname + "」" : "照片"}：` });
    try { const f = await ctx.line.content(id); blocks.push(...await toBlocks(f.bytes, f.type, fname)); }
    catch (e) { blocks.push({ type: "text", text: /讀不了|太大/.test(e.message) ? e.message : "（已經讀不到，LINE 只保留一段時間，請對方再傳一次）" }); }
  }
  return { __blocks: blocks };
}

/* 「Amy、Tom」「全部」「我」→ { ids: "all" | "U1,U2", names, missing } */
async function resolveMentions(db, chatId, text, me) {
  const s = String(text || "").trim();
  if (!s || s === "無") return { ids: null, names: null, missing: [] };
  if (/^(全部|所有人|大家|全體|全員|all|@?all)$/i.test(s)) return { ids: "all", names: "全體", missing: [] };
  const ids = [], names = [], missing = [];
  for (const n of s.split(/[、,，\s]+/).filter(Boolean)) {
    const m = n === "我" ? me : await findMember(db, chatId, n);
    if (m?.user_id) { if (!ids.includes(m.user_id)) { ids.push(m.user_id); names.push(m.name); } } else missing.push(n);
  }
  return { ids: ids.join(",") || null, names: names.join("、") || null, missing };
}
/* 群組名稱 → chatId（小幫手在的群組） */
async function findGroup(db, name) {
  const { results } = await db.prepare("SELECT k,v FROM line_kv WHERE k LIKE 'name:C%' OR k LIKE 'name:R%'").all();
  const n = String(name || "").trim();
  const hit = results.find(r => r.v === n) || results.find(r => r.v && (r.v.includes(n) || n.includes(r.v)));
  return hit ? { id: hit.k.slice(5), name: hit.v } : null;
}
async function groupLabel(db, chatId) { return isGroup(chatId) ? (await kv.get(db, "name:" + chatId)) || "群組" : "私訊"; }

async function findMember(db, chatId, name) {
  if (!name) return null;
  const { results } = await db.prepare("SELECT user_id,name FROM line_members WHERE chat_id=?").bind(chatId).all();
  const n = String(name).replace(/^@/, "").trim();
  return results.find(r => r.name === n) || results.find(r => r.name && (r.name.includes(n) || n.includes(r.name))) || null;
}

export async function runTool(ctx, name, input) {
  const { env, db, chatId, userId, userName, origin } = ctx;
  if (BOOK_TOOLS.some(t => t.name === name)) return runBookTool(ctx, name, input);
  if (name === "order_status") return orderStatus(ctx, input);
  if (name === "view_media") return viewMedia(ctx, input);
  if (name === "remember") {
    const text = String(input.text || "").trim().slice(0, 300);
    if (!text) return { error: "沒有內容" };
    const now = Date.now(), old = input.replaces ? await db.prepare("SELECT id,chat_id FROM line_memory WHERE id=?").bind(String(input.replaces)).first() : null;
    const mine = !old || old.chat_id === chatId;   // 非管理員只能改這個聊天室自己的
    if (!ctx.isAdmin && (input.sure === false || !mine)) {
      const id = await newDecision(db, { chatId, userId, kind: "memory", payload: { text, replaces: old?.id || null }, summary: text });
      const r = await escalate(ctx, `${userName || "有人"} 想讓我記住：「${text}」${input.reason ? "\n（" + String(input.reason).slice(0, 100) + "）" : ""}`, decisionCard("要記住這條嗎？", text, id, { all: true, note: "「設定」只用在提出的這個群組" }));
      return { pending: true, note: `還沒記，${told(r)}，請他按按鈕決定。回覆時自然地說你請 ${r.admin || "負責的人"} 確認一下，不要說「要找管理員」。` };
    }
    if (old && mine) {
      await db.prepare("UPDATE line_memory SET text=?, updated=?, created_by=? WHERE id=?").bind(text, now, userId, old.id).run();
      return { ok: true, updated: old.id, text, scope: old.chat_id ? "這個聊天室" : "所有群組" };
    }
    const id = rid(4), scope = ctx.isAdmin ? null : chatId;
    await db.prepare("INSERT INTO line_memory(id,text,created_by,created,updated,chat_id) VALUES(?,?,?,?,?,?)").bind(id, text, userId, now, now, scope).run();
    return { ok: true, id, text, scope: scope ? "這個聊天室" : "所有群組" };
  }
  if (name === "forget") {
    const m = await db.prepare("SELECT id,text,chat_id FROM line_memory WHERE id=?").bind(String(input.id)).first();
    if (!m) return { error: "找不到這條" };
    if (!ctx.isAdmin && m.chat_id !== chatId) {
      const id = await newDecision(db, { chatId, userId, kind: "forget", payload: { id: m.id }, summary: m.text });
      const r = await escalate(ctx, `${userName || "有人"} 想讓我忘記這條（所有群組通用的）：「${m.text}」`, decisionCard("要刪掉這條嗎？", m.text, id, { yes: "刪掉" }));
      return { pending: true, note: `還沒刪，${told(r)}，請他決定。回覆時自然地說你請 ${r.admin || "負責的人"} 確認一下。` };
    }
    const r = await db.prepare("DELETE FROM line_memory WHERE id=?").bind(m.id).run();
    return { ok: (r.meta?.changes ?? 1) > 0 };
  }
  if (name === "save_report") {
    const title = String(input.title || "報告").slice(0, 100);
    const content = String(input.content || "").slice(0, 200000).replace(/\*\*(.+?)\*\*/g, "$1").replace(/\n[ \t]*\n+/g, "\n");   // 粗體符號拿掉、不留空行
    if (!content) return { error: "沒有內容" };
    const name = `${title}${title.includes(ymd()) ? "" : "｜" + ymd()}${ctx.chatName ? "｜" + ctx.chatName : ""}`;
    try {
      let r;
      try { r = await gas(env, "saveDoc", name, content, "報告"); }
      catch (e) { if (!/unknown function/.test(e.message)) throw e; r = await gas(env, "saveTranscript", name, content); }   // Apps Script 還沒更新：先存在逐字稿資料夾
      const url = r.id ? `https://docs.google.com/document/d/${r.id}/edit` : r.url;
      (ctx.savedDocs ||= []).push({ title, url });
      return { ok: true, url, note: "存好了。回覆不要貼這個網址，系統會附「開啟文件」卡片" };
    } catch (e) { return { error: "存文件失敗：" + e.message + "；改成在 LINE 裡分段回覆重點" }; }
  }
  if (name === "ask_admin") {
    if (ctx.isAdmin) return { error: "跟你說話的就是管理員，直接回答他" };
    const r = await escalate(ctx, String(input.text || "").slice(0, 500));
    return { ok: r.how !== "none", note: told(r) + "。回覆時自然地說你請他處理，不要說「要找管理員」。" };
  }
  if (name === "assistant_cost") {
    if (!ctx.isAdmin) { const r = await escalate(ctx, `${userName || "有人"} 想知道小幫手這個月花了多少。`); return { pending: true, note: `費用只有管理員看得到，${told(r)}，請他回答。` }; }
    const m = /^\d{4}-\d{2}$/.test(input.month || "") ? input.month : ymd().slice(0, 7);
    return { ...(await buildReport(env, db, m)), note: "這是小助理（AI 與 LINE）本身的使用費用，不是任何人的帳務" };
  }
  switch (name) {
    case "search_chat": {
      if (!isGroup(chatId)) return { error: "這不是群組，沒有聊天紀錄" };
      const words = String(input.keyword || "").split(/\s+/).filter(Boolean).slice(0, 4);
      const from = input.from ? parseLocal(input.from + "T00:00") : 0, to = input.to ? parseLocal(input.to + "T23:59") : Date.now();
      let q = "SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>=? AND ts<=?", b = [chatId, from || 0, to];
      for (const w of words) { q += " AND text LIKE ?"; b.push("%" + w + "%"); }
      const { results: msgs } = await db.prepare(q + " ORDER BY id DESC LIMIT 80").bind(...b).all();
      let dq = "SELECT day,text FROM line_digests WHERE chat_id=? AND day>=? AND day<=?", db_ = [chatId, input.from || "0000", input.to || "9999"];
      for (const w of words) { dq += " AND text LIKE ?"; db_.push("%" + w + "%"); }
      const { results: digests } = await db.prepare(dq + " ORDER BY day DESC LIMIT 30").bind(...db_).all();
      return { messages: msgs.reverse().map(r => `[${md(ymd(r.ts))} ${hm(r.ts)}] ${r.name || "成員"}：${r.text}`).join("\n").slice(-30000) || "（最近 30 天的訊息裡沒找到）",
        daily_summaries: digests.map(d => `${d.day}：${d.text}`).join("\n").slice(0, 20000) || "（每日摘要裡沒找到）" };
    }
    case "read_chat": {
      if (!isGroup(chatId)) return { error: "這不是群組，沒有聊天紀錄" };
      const hours = Math.min(Math.max(Number(input.hours) || 24, 1), KEEP_DAYS * 24);
      const { results } = await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 600").bind(chatId, Date.now() - hours * HOUR).all();
      let lines = results.reverse().map(r => `[${md(ymd(r.ts))} ${hm(r.ts)}] ${r.name || "成員"}：${r.text}`), total = lines.length;
      while (lines.join("\n").length > 60000) lines.shift();
      return { hours, messages: total, shown: lines.length, transcript: lines.join("\n") || "（這段時間沒有紀錄）" };
    }
    case "read_transcript": {
      const all = await findTranscripts(db, chatId, input.keyword);
      if (!all.length) return { none: true, note: input.keyword ? "找不到含這個關鍵字的逐字稿" : "這裡最近 30 天沒有轉過錄音" };
      const brief = all.slice(0, 10).map(x => ({ when: when(x.ts), by: x.by, minutes: x.minutes, url: x.url }));
      if (input.list) return { transcripts: brief };
      const x = all[0];
      return { when: when(x.ts), by: x.by, minutes: x.minutes, url: x.url, speakers_are_codes: !!x.speakers, text: x.text.slice(0, 60000), others: brief.slice(1) };
    }
    case "list_members": {
      const { results } = await db.prepare("SELECT name FROM line_members WHERE chat_id=? ORDER BY updated DESC LIMIT 100").bind(chatId).all();
      return results.map(r => r.name);
    }
    case "add_todos": {
      const out = [];
      for (const it of (input.items || []).slice(0, 20)) {
        const m = await findMember(db, chatId, it.assignee === "我" ? userName : it.assignee);
        const due = it.due ? parseLocal(it.due) : null;
        const id = rid(4);
        await db.prepare("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES(?,?,?,?,?,?,'open',?,?)")
          .bind(id, chatId, String(it.task).slice(0, 300), m?.user_id || null, m?.name || it.assignee || null, isFinite(due) ? due : null, Date.now(), userId).run();
        if (isFinite(due)) await scheduleTodo(db, { todoId: id, chatId, task: String(it.task).slice(0, 300), due, aid: m?.user_id, aname: m?.name, by: userId });
        out.push({ id, task: it.task, assignee: m?.name || it.assignee || null, due: isFinite(due) ? when(due) : null, matched_member: !!m || !it.assignee });
      }
      return { added: out };
    }
    case "list_todos": {
      const q = input.include_done ? "SELECT * FROM line_todos WHERE chat_id=? ORDER BY status DESC, due IS NULL, due LIMIT 50" : "SELECT * FROM line_todos WHERE chat_id=? AND status='open' ORDER BY due IS NULL, due LIMIT 50";
      const { results } = await db.prepare(q).bind(chatId).all();
      return results.map(t => ({ id: t.id, task: t.task, assignee: t.assignee_name, due: t.due ? when(t.due) : null, overdue: t.due && t.due < Date.now() && t.status === "open", done: t.status === "done" }));
    }
    case "complete_todos": {
      const done = [];
      for (const id of (input.ids || []).slice(0, 20)) {
        const r = await db.prepare("UPDATE line_todos SET status='done' WHERE id=? AND chat_id=? AND status='open'").bind(String(id), chatId).run();
        if ((r.meta?.changes ?? 1) > 0) { done.push(id); await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE todo_id=? AND status='open'").bind(String(id)).run(); }
      }
      return { done };
    }
    case "set_reminder": {
      let due = parseLocal(input.when);
      if (input.auto && isFinite(due)) due = quiet(due);
      if (!isFinite(due)) return { error: "時間格式要是 YYYY-MM-DDTHH:mm" };
      if (due < Date.now() - 60e3) return { error: "這個時間已經過了" };
      let target = input.target === "me" ? userId : chatId, where = target === userId && isGroup(chatId) ? "私訊給發問者（對方要先加助理為好友才收得到）" : "這個聊天室";
      if (input.group) {
        const g = await findGroup(db, input.group);
        if (!g) { const { results } = await db.prepare("SELECT v FROM line_kv WHERE k LIKE 'name:C%'").all(); return { error: `找不到「${input.group}」這個群組`, groups_i_am_in: results.map(r => r.v) }; }
        // 只能排到自己也在的群組（管理員不限）
        const inside = ctx.isAdmin || await lineClient(env.LINE_CHANNEL_TOKEN).name(g.id, userId).catch(() => null);
        if (!inside) return { error: `你不在「${g.name}」裡，不能代發到那個群組` };
        target = g.id; where = `群組「${g.name}」`;
      }
      const men = isGroup(target) ? await resolveMentions(db, target, input.mention || "我", { user_id: userId, name: userName }) : { ids: null, names: null, missing: [] };
      const id = rid(4), repeat = REPEAT.includes(input.repeat) ? input.repeat : "none", kind = input.kind === "message" ? "msg" : null;
      await db.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES(?,?,?,?,?,?,?,NULL,?,?,'open',?)")
        .bind(id, target, due, String(input.text).slice(0, 300), repeat, men.ids, men.names, Date.now(), userId, kind).run();
      return { ok: true, id, when: when(due), repeat, where, kind: kind ? "代發訊息" : "提醒", mention: men.names,
        ...(men.missing.length ? { not_found: men.missing, note: "這些名字在那個群組還對不上（他要先在群組說過話我才認得），先 @ 其他人；跟對方說一聲" } : {}) };
    }
    case "update_reminder": {
      const r = await db.prepare("SELECT * FROM line_reminders WHERE id=? AND status='open' AND (chat_id=? OR created_by=?)").bind(String(input.id), chatId, userId).first();
      if (!r) return { error: "找不到這個提醒（可能已經發出或取消了），先用 list_reminders 看編號" };
      let due = r.due;
      if (input.when) { due = parseLocal(input.when); if (!isFinite(due)) return { error: "時間格式要是 YYYY-MM-DDTHH:mm" }; if (due < Date.now() - 60e3) return { error: "這個時間已經過了" }; }
      let mid = r.mention_id, mname = r.mention_name;
      if (input.mention && isGroup(r.chat_id)) { const men = await resolveMentions(db, r.chat_id, input.mention, { user_id: userId, name: userName }); if (!men.ids) return { error: `群組裡找不到「${men.missing.join("、")}」` }; mid = men.ids; mname = men.names; }
      const text = input.text ? String(input.text).slice(0, 300) : r.text, repeat = REPEAT.includes(input.repeat) ? input.repeat : r.repeat;
      await db.prepare("UPDATE line_reminders SET due=?,text=?,repeat=?,mention_id=?,mention_name=? WHERE id=?").bind(due, text, repeat, mid, mname, r.id).run();
      return { ok: true, id: r.id, when: when(due), text, repeat, mention: mname };
    }
    case "update_todo": {
      const t = await db.prepare("SELECT * FROM line_todos WHERE id=? AND chat_id=? AND status='open'").bind(String(input.id), chatId).first();
      if (!t) return { error: "找不到這個待辦（可能已經完成了），先用 list_todos 看編號" };
      let aid = t.assignee_id, aname = t.assignee_name, due = t.due;
      if (input.assignee) { const m = await findMember(db, chatId, input.assignee === "我" ? userName : input.assignee); aid = m?.user_id || null; aname = m?.name || input.assignee; }
      if (input.due === "無") due = null;
      else if (input.due) { due = parseLocal(input.due); if (!isFinite(due)) return { error: "期限格式要是 YYYY-MM-DDTHH:mm" }; }
      const task = input.task ? String(input.task).slice(0, 300) : t.task;
      await db.prepare("UPDATE line_todos SET task=?,assignee_id=?,assignee_name=?,due=? WHERE id=?").bind(task, aid, aname, due, t.id).run();
      await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE todo_id=? AND status='open'").bind(t.id).run();
      if (due) await scheduleTodo(db, { todoId: t.id, chatId, task, due, aid, aname, by: userId });
      return { ok: true, id: t.id, task, assignee: aname, due: due ? when(due) : null };
    }
    case "list_reminders": {
      const { results } = await db.prepare("SELECT id,chat_id,due,text,repeat,mention_name,kind FROM line_reminders WHERE status='open' AND (chat_id=? OR created_by=?) ORDER BY due LIMIT 40").bind(chatId, userId).all();
      const out = [];
      for (const r of results) out.push({ id: r.id, when: when(r.due), text: r.text, repeat: r.repeat, mention: r.mention_name, kind: r.kind === "msg" ? "代發訊息" : "提醒", where: r.chat_id === chatId ? "這裡" : r.chat_id === userId ? "私訊" : await groupLabel(db, r.chat_id) });
      return out;
    }
    case "cancel_reminder": {
      const r = await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE id=? AND status='open' AND (chat_id=? OR chat_id=? OR created_by=?)").bind(String(input.id), chatId, userId, userId).run();
      return { ok: (r.meta?.changes ?? 1) > 0 };
    }
  }
  return { error: "沒有這個工具" };
}


/* ---------- Claude ---------- */
function systemPrompt(ctx) {
  const now = Date.now();
  const where = isGroup(ctx.chatId) ? `你在 LINE 群組「${ctx.chatName || "工作群組"}」裡，現在跟你說話的是「${ctx.userName}」。群組裡大家都能叫你。` : `你在和「${ctx.userName}」一對一聊天。`;
  const o = ctx.origin;
  return `你是 LINE 上的工作小助理，幫忙回答問題、整理群組討論、管理待辦和提醒。
${where}
現在是台北時間 ${ymd(now)}（星期${WEEK[tp(now).getUTCDay()]}）${hm(now)}。

做事原則：
- 只回應這次叫你的這一則訊息。前面的對話和群組訊息只是背景；已經處理過、回覆過的事完全不要再提，不要更正、補充或道歉以前的回覆，除非這次訊息很明確地又問到那件事。被問到已處理的事，清楚說明已經處理了、結果是什麼就好，不用多解釋。
- 大家不會用指令，只會用平常講話的方式交辦或發問；自己判斷要做什麼，直接做完再簡短回報。
- 群組裡沒有 @你 的討論你都看得到（read_chat）；有人問「剛剛／之前說的…」「誰負責…」就去查紀錄回答：最近一兩天用 read_chat，更早的或要找特定的事用 search_chat（可以查到一年內的每日摘要）。
- 有人說「這張」「截圖」「剛傳的檔案」或回覆某張照片／檔案叫你，用 view_media 看內容再回答。
- 有人要工作清單（「今天要做什麼」「這週有哪些事」「我的待辦」）時，用 list_todos 和 list_reminders 整理：先列到期或逾期的，再列其他；問「我的」就只列他負責的。不會主動發清單。
- 改提醒時間、延後、改內容用 update_reminder；改待辦的期限、負責人用 update_todo。
- 有人交辦事情（例如「記得提醒他」「週五前要完成」），直接記下來，不用再問要不要；只有負責人或時間真的不清楚才問一句。某人要「做完」的事（交報價、回覆客戶、寄東西）用 add_todos 並填期限：到期提醒會附「已完成」按鈕，負責人按了就不再提醒。只是到點通知、沒有要誰完成什麼（開會、出門、每天固定提醒）才用 set_reminder。
- 有人說某件事「做完了」「交了」「搞定」，用 list_todos 找到對應的待辦再用 complete_todos 標完成，回一句「好，已劃掉」之類的就好。
- 對話紀錄裡標了［已完成：…］的事已經做過了，不要重做或重設；不確定有沒有設好就用 list_reminders／list_todos 查，不要憑印象說「其實沒設定」。
- 需要資料時用工具，不要編造。問到法規、價格、新聞、天氣、營業時間這類會變動或你不確定的事，用 web_search 查，回答時說是從哪裡查到的（網站名稱就好，不用貼一長串網址）。群組內部的事不要上網查。日期說「明天」「下週五」要換算成實際日期。
- 總結群組討論時先用 read_chat，分成重點、決定、待辦（誰／做什麼／何時），沒有的那段就省略；如果討論裡有明確的待辦（有人、有事），直接用 add_todos 加入並在最後列出；不明確的就列出來問一句。
- 只轉述聊天紀錄裡真的有的內容；不確定誰負責就寫「未指定」。不要評論個人、不要揣測私事。
- 只講「12點」「3點」沒講上午下午時，指的是接下來最近的那個時間（例如晚上 11 點多說「12點」就是今晚 12 點）。
- 群組裡的提醒一律要 @人：指定誰就 @誰（可以多人）；全體都要參與或注意的事（開會、公告、大家都要做的）mention 填「全部」（@All）；沒說是誰就填「我」@提出的人。
- 可以幫人排程到他也在的其他群組（例如在私訊說「明天 9 點在廣告群提醒 Amy 交報表」）：set_reminder 填 group；要代發公告、通知這類訊息（不是提醒）用 kind=message，內容照他要的原文。設好後回報會在哪個群組、幾點、@誰。
- 提醒時間沒講幾點，預設早上 9 點並說明。待辦有期限時，系統會自動在前一天 16:00 和到期時提醒負責人，過期沒按「已完成」每天早上 9 點再提醒，不用另外設。
- 要你提醒開會而沒指定提醒時間時，每場會議用 set_reminder 設兩個（auto=true）：前一天 18:00「明天 HH:MM〔會議名稱〕（地點）：請大家先把要討論的事項提出來」，會議前 30 分鐘「30 分鐘後〔會議名稱〕（地點）」。前一天 18:00 已經過了就只設前 30 分鐘。對方有指定提醒時間就照他說的。在群組設提醒，預設發在群組；說「私訊我」才用 target=me。
${ctx.book && ctx.book.type === "log" ? `- 這個群組綁定了紀錄表「${ctx.book.name}」，欄位：${ctx.book.headers.join("、")}。有人要你記下一筆（測試結果、數據、決定）時：先用 book_info 看欄位和最近的寫法，再用 propose_rows 列出（欄位名稱完全照表頭、日期 YYYY-MM-DD、數字只寫數字），系統會讓人按「確認」才寫入；確認前不要說「已記下」。問以前的紀錄（「上次 A/B 測試結果」）時用 book_info／讀表的工具查。` : ""}${ctx.book && ctx.book.type !== "log" ? `- 這個群組綁定了記帳表「${ctx.book.name}」，欄位：${ctx.book.headers.join("、")}。有人請你記帳時：先用 book_info 看欄位和最近的寫法，再用 propose_rows 列出（欄位名稱完全照表頭、日期 YYYY-MM-DD、金額只寫數字），系統會讓人按「確認」才寫入；確認前不要說「已記帳」。說「這張」「剛剛的單據」時用 recent_photos 讀照片。資訊不足（例如金額、品項）先問。` : ""}${ctx.book ? "" : `- 這個聊天室沒有綁定表格；有人要記帳或記錄（例如 A/B 測試結果），跟他說可以 @你 說「設定記帳表」或「設定紀錄表」，你會請 ${ctx.adm?.name || "負責的人"} 確認。`}
- 除了綁定的記帳表，你不處理任何人的帳務或個人財務資料。
${ctx.isAdmin ? "- 他問「你花了我多少錢」「目前花費」「用量」這類問題，指的是你（小助理）自己的 AI 使用費用，用 assistant_cost 查了再回答，金額同時寫美元和約台幣。" : ""}
- 問到廣告或平台（Meta／Facebook／Instagram、Google／YouTube、LINE、TikTok）的政策、規範、審核標準、功能變動：搜尋時限定官方網站（例如 site:transparency.meta.com、site:facebook.com/business、site:support.google.com、site:tw.linebiz.com、site:ads.tiktok.com），回答寫出官方頁面名稱、網址和頁面上的更新日期；找不到官方來源或看不到日期，就明說「沒找到官方的最新說明」，不要拿第三方文章當定論。
- 對方貼網址要你看，用 web_fetch 讀；讀不到（要登入、靠程式動態載入，像 Facebook 廣告檔案庫）就直說，請他截圖或把內容貼上來。
- 問題本身需要詳細調查或分析時（比較多個選項、策略規劃、市場或競品研究、數據解讀、需要多個來源佐證），就算對方沒說「詳細」，也要多查幾個來源、完整回答，太長就用 save_report 存成文件；一般問答、閒聊、交辦維持精簡。
- 讀到檔案裡有「系統用程式算好的數字」時，數字一律照那段，不要自己重算；你負責解讀：哪裡好、哪裡差、可能原因、下一步建議。
- 工具回傳的編號（像 6d6f65、ab12 這種英數字）是系統內部用的，回覆時絕對不要寫出來；提醒和待辦用「時間＋內容」或負責人來稱呼，例如「10/31 早上 9 點：小兔完成交接」。對方要改或取消時，用 list_reminders／list_todos 查出編號再操作。
- 對話紀錄裡使用者訊息前面的［月/日 時:分］是那則訊息的發送時間。以前設的提醒要用當時的時間判斷對不對（例如昨晚 23:35 說「明早 6:00」就是今天 6:00），不要拿現在的時間去比。
- 只處理這次叫你的事，不要主動翻舊對話、檢查無關的設定或提醒。真的發現問題，先用工具查證（例如 list_reminders），確定了才用一句話提，不要猜。
- 用 save_report 存好文件後：回一句說明加最多 3 行重點，不要描述文件的結構或欄數，也不要貼網址，系統會附「開啟文件」的卡片。
- 不確定就說不確定。

說話方式：
- 像一個做事俐落的同事在 LINE 上回話：直接講重點，口語、自然，不客套。
- 不要開場白和結尾客套（不說「您好」「很高興為您服務」「還有什麼需要幫忙的嗎」），不自我介紹，不主動列出自己會做什麼。
- 稱呼用「你」，不用「您」。不要說自己是 AI 或機器人，也不要道歉一大串；做錯了就簡短說「抱歉，我更正」。
- 辦完事只回結果，一兩句就好，例如「好，週五早上 9 點提醒小陳交報價單。」
- 回答長度跟問題相稱：簡單問題一句話；整理討論才用條列。條列用「・」，不用 #、**、表格。
- 少用表情符號。繁體中文，金額加千分位。`;
}

export async function claude(env, body, timeoutMs) {
  const ac = timeoutMs ? new AbortController() : null, timer = ac && setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: ac?.signal });
  } catch (e) { if (ac?.signal.aborted) { const t = new Error("Claude timeout"); t.status = 408; throw t; } throw e; }
  finally { if (timer) clearTimeout(timer); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error("Claude " + r.status + " " + (j.error?.message || "")); e.status = r.status; throw e; }
  return j;
}

export async function chat(ctx, userContent, logText) {
  const { env, db, chatId } = ctx;
  const full = !isGroup(chatId);   // 一對一私訊：完整 Claude 模式（記得較長的對話、可以詳細回答）
  const { results } = await db.prepare("SELECT role,text,ts FROM line_history WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT ?").bind(chatId, Date.now() - (full ? 7 * DAY : DAY), full ? 40 : 12).all();
  const messages = [];
  for (const h of results.reverse()) {
    const role = h.role === "user" ? "user" : "assistant";
    // 使用者的每則前面加上當時的時間：「明天」「三分鐘後」要用那則的時間判斷，不是現在
    const text = role === "user" ? `［${md(ymd(h.ts))} ${hm(h.ts)}］${h.text}` : h.text;
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += "\n" + text;
    else messages.push({ role, content: text });
  }
  if (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length && messages[messages.length - 1].role === "user") messages.push({ role: "assistant", content: "（好的）" });
  // 群組裡附上最近的對話，讓「剛剛說的那個」看得懂
  if (isGroup(chatId)) {
    const { results: recent } = await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 21").bind(chatId, Date.now() - 6 * HOUR).all();
    if (recent.length && recent[0].text === ctx.rawText) recent.shift();   // 最新一則就是這次叫它的訊息
    // 之前叫過它的訊息已經處理過（在對話紀錄裡），不放進背景，免得它又去回那些
    for (let i = recent.length - 1; i >= 0; i--) if (/^\s*(@小幫手|@小助理|\/|小助理|小幫手)/.test(recent[i].text || "")) recent.splice(i, 1);
    if (recent.length) userContent = [{ type: "text", text: "（群組最近的對話，由舊到新；只是背景，不要回應裡面的事，要回應的是最後這則叫你的訊息）\n" + recent.reverse().map(r => `[${hm(r.ts)}] ${r.name}：${r.text}`).join("\n").slice(-4000) }, ...userContent];
  }
  // 把「這次要處理的訊息」放在最後、明確標出來
  if (isGroup(chatId) && ctx.rawText != null) {
    const i = userContent.findIndex(b => b.type === "text" && !b.text.startsWith("（群組最近的對話"));
    userContent.splice(i < 0 ? userContent.length : i, 0, { type: "text", text: "（以上都是背景。現在要處理的只有下面這一則，照它的意思做，不要去回之前的訊息：）" });
  }
  messages.push({ role: "user", content: userContent });

  const allFlows = (await kv.json(db, "flows", [])).filter(f => f.enabled !== false);
  ctx.flows = allFlows.filter(f => ctx.isAdmin || f.notify === chatId || f.alert === chatId);
  const all = [...TOOLS, REPORT_TOOL, ...(ctx.flows.length ? [ORDER_TOOL] : []), ...(ctx.book ? BOOK_TOOLS : []), ...MEMORY_TOOLS, COST_TOOL, ...(ctx.isAdmin ? [] : [ASK_ADMIN])];
  const tools = all.map((t, i) => i === all.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t);
  // 網路搜尋（Claude 內建；每次 US$0.01，每次回覆最多 3 次）
  // 這次叫它的那句話（群組只看叫它的那則，不看背景對話）：要不要詳細、要不要深入查
  const askText = String(ctx.rawText ?? userContent.filter(b => b.type === "text").map(b => b.text).join(" "));
  const deep = DEEP_RE.test(askText), research = deep || RESEARCH_RE.test(askText);
  ctx.deep = deep;
  const searchOff = Number(await kv.get(db, "websearch:off")) > Date.now() - DAY;
  if (env.WEB_SEARCH !== "off" && !searchOff) tools.unshift({ type: "web_search_20250305", name: "web_search", max_uses: 8, user_location: { type: "approximate", country: "TW", timezone: "Asia/Taipei" } });
  // 讀網址（不另外收費，只算讀進來的字）；需要登入或動態載入的頁面讀不到
  const fetchOff = Number(await kv.get(db, "webfetch:off")) > Date.now() - DAY;
  if (env.WEB_FETCH !== "off" && !fetchOff) tools.unshift({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 5, max_content_tokens: 20000 });
  const mem = await memories(db, chatId);
  const memText = mem.length ? "\n\n大家教過你的事（回答時要遵守和參考；標〔本聊天室〕的只適用這裡，其他所有群組通用）：\n" + mem.map(m => `[${m.id}]${m.chat_id ? "〔本聊天室〕" : ""} ${m.text}`).join("\n")
    : "";
  ctx.adm = ctx.adm !== undefined ? ctx.adm : await adminFor(env, db, chatId).catch(() => null);
  const adminName = ctx.adm?.name || "管理員";
  const teach = (ctx.isAdmin ? `\n- 跟你說話的 ${ctx.userName || "這位"} 是管理員。他說「記住…」「以後…都…」時用 remember 記下（所有群組都適用）；跟上面某條是同一件事就用 replaces 更新那條。說「忘記…」用 forget。問「你記得什麼」就列出來。`
    : `\n- 任何人說「記住…」「以後…都…」都用 remember：確定沒問題的直接記（只用在這個聊天室）；拿不準的 sure=false，系統會 @${adminName} 按鈕決定。說「忘記…」用 forget。問「你記得什麼」就列出來。`)
    + `\n- 管理員是 ${adminName}。需要他處理或決定的事，直接用 ask_admin 叫他，回一句「我請 ${adminName} 看一下」這類自然的話；絕對不要說「請找管理員」「需要管理員權限」這種話。`;
  const flows = ctx.flows.filter(f => f.desc);
  const flowText = flows.length ? "\n\n已在運作的自動流程（每分鐘自動檢查，不用人叫你；被問到就照實說明）：\n" + flows.map(f => "・" + f.desc).join("\n") +
    "\n有人 tag 你要轉單、叫貨、訂購或問訂單時，先用 order_status 查，再把那筆的狀況講清楚：以「回覆」那句為主，必要的資訊（例如缺哪些欄位、什麼時候送的）可以補上，但不要解釋流程怎麼運作、不要講無關的事。查不到就說客服表還沒有這筆訂單。" : "";
  const deepText = !full && deep ? `

這次對方要詳細的內容：不受「群組回覆要精簡」的限制，可以完整、分段回答，先給結論再展開。內容超過約 1,500 字、有表格或要留存的，用 save_report 存成 Google 文件，LINE 裡只回 5 到 8 行重點和文件連結。` : "";
  const fullText = full ? `

這是一對一私訊，不是群組：在這裡你就是完整的 Claude，什麼都可以聊、可以問（工作、生活、寫作、分析、翻譯、算數、程式、學習…），不限於小助理的功能。上面「回答長度跟問題相稱」仍然適用，但需要時可以詳細、分段、條列完整回答，不用刻意精簡；先給結論再展開。
- LINE 不會顯示 Markdown：不要用 #、**、表格；分段用空行，條列用「・」或「1.」。
- LINE 最多分 5 則送出，總長請控制在 15,000 字內；更長就先給重點，問他要不要繼續。
- 記得這段私訊之前聊過的內容，接著聊。` : "";
  const system = [{ type: "text", text: systemPrompt(ctx) + teach + memText + flowText + fullText + deepText }];
  // 回話用較聰明的模型；背景小事（判斷廠商回覆、每日摘要）在別處用便宜的 Haiku
  let model = env.CHAT_MODEL || "claude-sonnet-5-5";
  // 私訊裡說「仔細想」「深入分析」這類，改用最強的 Opus
  // 說「仔細想」「深入分析」這類（私訊或群組都可以），改用最強的 Opus
  if (/(細想|認真想|好好想|想清楚|深入分析|仔細分析|用\s*opus)/i.test(askText)) model = env.DEEP_MODEL || "claude-opus-5-5";
  // 雲端主機在回覆 LINE 之後只給約 30 秒，所以整段思考要在 26 秒內做完
  // 走排隊服務時可以想很久（最多約 10 分鐘）；沒有排隊服務時，回覆 LINE 後只剩約 30 秒，要在 26 秒內做完
  const long = env.LONG_RUN === "1";
  const maxTokens = full || deep ? (long ? 8000 : /opus/.test(model) ? 1800 : 2500) : long ? 6000 : 1500;
  const t0 = Date.now(), BUDGET = Number(env.AI_BUDGET_MS) || (long ? 300000 : 26000);
  let timedOut = false, cutShort = false;
  let text = "";
  const done = [];
  for (let round = 0; round < 6; round++) {
    let res;
    const left = BUDGET - (Date.now() - t0);
    if (left < 4000) { timedOut = true; break; }
    // 時間用掉一半以上：這一輪直接用手上的資料回答，不再查東西
    const last = round > 0 && Date.now() - t0 > BUDGET * 0.55;
    const body = { model, max_tokens: last ? Math.min(maxTokens, 700) : maxTokens, system, tools, messages, ...(last ? { tool_choice: { type: "none" } } : {}) };
    try { res = await claude(env, body, left); }
    catch (e) {
      // 網路搜尋沒開通（或這個模型不支援）就拿掉搜尋再試一次，一天後再試開
      if (e.status === 400 && tools[0]?.name === "web_fetch" && /web_fetch|fetch/i.test(e.message)) {
        console.log("web fetch disabled", e.message); tools.shift(); await kv.set(db, "webfetch:off", String(Date.now()));
        res = await claude(env, { ...body, tools }, BUDGET - (Date.now() - t0));
      } else if (e.status === 400 && tools.some(t => t.name === "web_search") && /web_search|server tool|tool/i.test(e.message)) {
        const i = tools.findIndex(t => t.name === "web_search"); tools.splice(i, 1);
        console.log("web search disabled", e.message); await kv.set(db, "websearch:off", String(Date.now()));
        res = await claude(env, { ...body, tools }, BUDGET - (Date.now() - t0));
      } else if ((e.status === 404 || (e.status === 400 && /model/i.test(e.message))) && model !== "claude-haiku-5-5") {
        console.log("model fallback", model, e.message); model = /opus/.test(model) ? "claude-sonnet-5-5" : "claude-haiku-5-5";
        res = await claude(env, { ...body, model }, BUDGET - (Date.now() - t0));
      } else if (e.status === 408) { timedOut = true; break; }
      else throw e;
    }
    if (res.usage) await recordAI(env, db, { chatId, userId: ctx.userId, model, usage: res.usage }).catch(e => console.log("usage", e.message));
    const blocks = res.content || [];
    text = blocks.filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (res.stop_reason === "max_tokens") cutShort = true;
    if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: blocks }); continue; }   // 搜尋還沒做完，接著跑
    if (res.stop_reason !== "tool_use") break;
    messages.push({ role: "assistant", content: blocks });
    const out = [];
    for (const b of blocks.filter(b => b.type === "tool_use")) {
      let r;
      try { r = await runTool(ctx, b.name, b.input || {}); } catch (e) { r = { error: e.message }; }
      if (WRITE_TOOLS[b.name] && r && !r.error) done.push(WRITE_TOOLS[b.name](b.input || {}, r));
      out.push({ type: "tool_result", tool_use_id: b.id, content: r && r.__blocks ? r.__blocks : JSON.stringify(r).slice(0, 70000) });
    }
    messages.push({ role: "user", content: out });
  }
  if (timedOut && !text) text = "這題比較大，我沒能在時間內想完。可以拆成小一點的問題，或跟我說「簡短回答」。";
  else if (cutShort && full) text += "\n\n（還沒寫完，回「繼續」我接著寫）";
  await checkBudget(env, db).catch(e => console.log("budget", e.message));
  text = cleanText(text) || (ctx.pending ? "請確認：" : "我沒有聽懂，可以換個說法嗎？");
  if (ctx.pending && !text.includes(ctx.pending.summary.slice(0, 15))) text += "\n\n" + ctx.pending.summary;
  const who = isGroup(chatId) ? `${ctx.userName}：` : "";
  await db.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").bind(chatId, "user", (who + logText).slice(0, full ? 4000 : 2000), Date.now()).run();
  const note = done.length ? "\n［已完成：" + done.join("；") + "］" : "";
  const keep = full ? 6000 : 1800;
  await db.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").bind(chatId, "assistant", (text.slice(0, keep) + note).slice(0, keep + 600), Date.now()).run();
  return { text, pending: ctx.pending || null };
}

export function cleanText(t) {
  return String(t || "").replace(/^#{1,6}\s*/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^\s*[-*]\s+/gm, "・").replace(/`{1,3}/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- 不用 AI 的快速指令 ---------- */
export async function todoText(db, chatId) {
  const { results } = await db.prepare("SELECT * FROM line_todos WHERE chat_id=? AND status='open' ORDER BY due IS NULL, due LIMIT 30").bind(chatId).all();
  if (!results.length) return "目前沒有待辦。";
  return "待辦：\n" + results.map(t => `・${t.task}${t.assignee_name ? "（" + t.assignee_name + "）" : ""}${t.due ? "｜" + when(t.due) + (t.due < Date.now() ? " ⚠ 已過期" : "") : ""}`).join("\n")
    + "\n\n做完的按下面的「✓」，或跟我說一聲，例如「報價單交了」。";
}
export async function completeByText(db, chatId, text) {
  const ids = (text.match(/[0-9a-f]{4}/gi) || []).slice(0, 10);
  const done = [];
  for (const id of ids) {
    const r = await db.prepare("UPDATE line_todos SET status='done' WHERE id=? AND chat_id=? AND status='open'").bind(id.toLowerCase(), chatId).run();
    if ((r.meta?.changes ?? 1) > 0) { done.push(id); await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE todo_id=? AND status='open'").bind(id.toLowerCase()).run(); }
  }
  return done.length ? `✓ 已完成：${done.join("、")}` : "找不到這項，跟我說是哪一件就好。";
}

export function nextDue(due, repeat) {
  const t = tp(due);
  if (repeat === "daily") return due + DAY;
  if (repeat === "weekly") return due + 7 * DAY;
  if (repeat === "weekdays") { let n = due + DAY; while ([0, 6].includes(tp(n).getUTCDay())) n += DAY; return n; }
  if (repeat === "monthly") {
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate(), last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d, last), t.getUTCHours(), t.getUTCMinutes()) - 8 * HOUR;
  }
  return null;
}

/* ---------- 說明文字 ---------- */
export const HELP_GROUP = `有事 @我，像跟同事講話一樣就好，例如：
・整理一下今天的討論
・週五前小陳要交報價單，記得提醒他
・剛剛說的交期是哪天？
・會議錄音傳上來後，回覆那段錄音 @我「整理一下」
・廣告影片傳上來後，回覆那支影片 @我，我看封面、聽旁白給建議`;
export const HELP_USER = `有事直接說就好，例如：
・明天早上 9 點提醒我回電王會計
・週五前要寄合約給客戶
・傳會議錄音給我，我轉成逐字稿並整理重點`;
export const JOIN_NOTICE = `大家好，我是小助理。交辦、提醒、問事情，@我 就好。
群組討論我會記 ${KEEP_DAYS} 天（由 AI 整理），之後可以隨時問我；不想被記錄的人跟我說「不要記錄我」。`;
