// LINE 群組助理：群組裡每個人都能用。不碰任何人的帳本或個人財務資料。
// Claude 負責理解與回答；工具負責讀群組紀錄做總結、待辦、提醒、報稅期限、統編查詢，
// 以及廠商群組的記帳（寫進該群組綁定的雲端試算表，按確認才寫入）。
import { BOOK_TOOLS, runBookTool } from "./books.js";

const ROLE_NAMES = { company: "公司・行號", person: "上班族・接案", landlord: "房東・屋主", car: "有車" };
const HOUR = 3600e3, DAY = 24 * HOUR;
export const KEEP_DAYS = 30;                  // 群組訊息紀錄保留天數
const LIMIT_USER = 30, LIMIT_ALL = 400;       // 每人、全體每天最多呼叫 AI 次數（防止費用暴衝）

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
export const isGroup = chatId => /^[CR]/.test(chatId || "");

/* ---------- 資料表 ---------- */
export const kv = {
  get: async (db, k) => (await db.prepare("SELECT v FROM line_kv WHERE k=?").bind(k).first())?.v ?? null,
  set: (db, k, v) => db.prepare("INSERT INTO line_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(),
  json: async (db, k, d) => { try { return JSON.parse(await kv.get(db, k)) ?? d; } catch (e) { return d; } },
};

/* 每天的 AI 用量上限；超過回 false */
export async function allowAI(db, userId) {
  const day = ymd(), ku = `ai:${day}:${userId}`, ka = `ai:${day}:all`;
  const u = Number(await kv.get(db, ku)) || 0, a = Number(await kv.get(db, ka)) || 0;
  if (u >= LIMIT_USER || a >= LIMIT_ALL) return false;
  await kv.set(db, ku, u + 1); await kv.set(db, ka, a + 1);
  return true;
}

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

/* ---------- 報稅期限 ---------- */
export async function deadlines(env, origin, days = 30, roles = ["company", "person"]) {
  const res = await env.ASSETS.fetch(new URL("/assets/deadlines.json", origin));
  const data = await res.json();
  const today = ymd(), until = ymd(Date.now() + days * DAY);
  return data.items.filter(it => it.due >= today && it.due <= until && it.roles.some(r => roles.includes(r)))
    .map(it => ({ due: it.due, title: it.title, start: it.start, note: it.desc, link: it.link ? origin + it.link : null, who: it.roles.map(r => ROLE_NAMES[r]).join("、") }));
}

/* ---------- 工具 ---------- */
const REPEAT = ["none", "daily", "weekdays", "weekly", "monthly"];
export const TOOLS = [
  { name: "read_chat", description: "讀這個群組最近的聊天紀錄（做總結、找誰說過什麼、整理待辦時用）。只有群組裡能用。",
    input_schema: { type: "object", properties: { hours: { type: "integer", description: "往回幾小時，預設 24，最多 720" } } } },
  { name: "list_members", description: "列出這個聊天室已知的成員名稱（要 @ 人或指派待辦時用）。", input_schema: { type: "object", properties: {} } },
  { name: "add_todos", description: "把待辦加入這個聊天室的待辦清單。有期限的會在期限當天提醒，並 @ 負責人。只在使用者要求或同意時使用。",
    input_schema: { type: "object", properties: { items: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: {
      task: { type: "string" }, assignee: { type: "string", description: "負責人名稱（用成員名稱），沒有就省略" },
      due: { type: "string", description: "期限，台北時間 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，沒有就省略" } }, required: ["task"] } } }, required: ["items"] } },
  { name: "list_todos", description: "列出這個聊天室的待辦。", input_schema: { type: "object", properties: { include_done: { type: "boolean" } } } },
  { name: "complete_todos", description: "把待辦標成完成（用 list_todos 的編號）。", input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
  { name: "set_reminder", description: "設定提醒。target=here 發在目前聊天室，target=me 私訊提醒發問的人（對方要先加助理好友）。",
    input_schema: { type: "object", properties: { when: { type: "string", description: "台北時間 YYYY-MM-DDTHH:mm" }, text: { type: "string" },
      repeat: { type: "string", enum: REPEAT }, target: { type: "string", enum: ["here", "me"] },
      mention: { type: "string", description: "提醒時要 @ 的成員名稱；「我」代表發問的人。只在群組有用" } }, required: ["when", "text"] } },
  { name: "list_reminders", description: "列出這個聊天室和發問者自己還沒到的提醒。", input_schema: { type: "object", properties: {} } },
  { name: "cancel_reminder", description: "取消提醒（用 list_reminders 的編號）。", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "tax_deadlines", description: "台灣報稅與繳費期限（營業稅、扣繳、勞健保、綜所稅、房屋稅、牌照稅等）。",
    input_schema: { type: "object", properties: { days: { type: "integer", maximum: 400, description: "未來幾天內，預設 30" },
      roles: { type: "array", items: { type: "string", enum: Object.keys(ROLE_NAMES) }, description: "company 公司行號、person 上班族接案、landlord 房東、car 有車；預設 company,person" } } } },
  { name: "company_lookup", description: "查台灣公司或行號登記資料（經濟部商工登記）。", input_schema: { type: "object", properties: { ubn: { type: "string" }, keyword: { type: "string" } } } },
  { name: "brief_settings", description: "這個聊天室的每日早報：開關、時間、報稅身分。早報內容是報稅期限、今天到期的待辦和提醒。",
    input_schema: { type: "object", properties: { on: { type: "boolean" }, time: { type: "string", description: "HH:mm" }, roles: { type: "array", items: { type: "string", enum: Object.keys(ROLE_NAMES) } } } } },
];

async function findMember(db, chatId, name) {
  if (!name) return null;
  const { results } = await db.prepare("SELECT user_id,name FROM line_members WHERE chat_id=?").bind(chatId).all();
  const n = String(name).replace(/^@/, "").trim();
  return results.find(r => r.name === n) || results.find(r => r.name && (r.name.includes(n) || n.includes(r.name))) || null;
}

export async function runTool(ctx, name, input) {
  const { env, db, chatId, userId, userName, origin } = ctx;
  if (BOOK_TOOLS.some(t => t.name === name)) return runBookTool(ctx, name, input);
  switch (name) {
    case "read_chat": {
      if (!isGroup(chatId)) return { error: "這不是群組，沒有聊天紀錄" };
      const hours = Math.min(Math.max(Number(input.hours) || 24, 1), KEEP_DAYS * 24);
      const { results } = await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 600").bind(chatId, Date.now() - hours * HOUR).all();
      let lines = results.reverse().map(r => `[${md(ymd(r.ts))} ${hm(r.ts)}] ${r.name || "成員"}：${r.text}`), total = lines.length;
      while (lines.join("\n").length > 60000) lines.shift();
      return { hours, messages: total, shown: lines.length, transcript: lines.join("\n") || "（這段時間沒有紀錄）" };
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
        if (isFinite(due) && due > Date.now())
          await db.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status) VALUES(?,?,?,?,'none',?,?,?,?,?,'open')")
            .bind(rid(6), chatId, due, "待辦到期：" + String(it.task).slice(0, 300), m?.user_id || null, m?.name || null, id, Date.now(), userId).run();
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
      const due = parseLocal(input.when);
      if (!isFinite(due)) return { error: "時間格式要是 YYYY-MM-DDTHH:mm" };
      if (due < Date.now() - 60e3) return { error: "這個時間已經過了" };
      const target = input.target === "me" ? userId : chatId;
      let m = null;
      if (isGroup(target) && input.mention) m = input.mention === "我" ? { user_id: userId, name: userName } : await findMember(db, chatId, input.mention);
      const id = rid(4), repeat = REPEAT.includes(input.repeat) ? input.repeat : "none";
      await db.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status) VALUES(?,?,?,?,?,?,?,NULL,?,?,'open')")
        .bind(id, target, due, String(input.text).slice(0, 300), repeat, m?.user_id || null, m?.name || null, Date.now(), userId).run();
      return { ok: true, id, when: when(due), repeat, where: target === userId && isGroup(chatId) ? "私訊給發問者（對方要先加助理為好友才收得到）" : "這個聊天室", mention: m?.name || null };
    }
    case "list_reminders": {
      const { results } = await db.prepare("SELECT id,chat_id,due,text,repeat,mention_name FROM line_reminders WHERE status='open' AND (chat_id=? OR (chat_id=? AND created_by=?)) ORDER BY due LIMIT 30").bind(chatId, userId, userId).all();
      return results.map(r => ({ id: r.id, when: when(r.due), text: r.text, repeat: r.repeat, mention: r.mention_name, where: r.chat_id === chatId ? "這裡" : "私訊" }));
    }
    case "cancel_reminder": {
      const r = await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE id=? AND status='open' AND (chat_id=? OR chat_id=?)").bind(String(input.id), chatId, userId).run();
      return { ok: (r.meta?.changes ?? 1) > 0 };
    }
    case "tax_deadlines": return await deadlines(env, origin, Math.min(Number(input.days) || 30, 400), input.roles?.length ? input.roles : ["company", "person"]);
    case "company_lookup": {
      const q = input.ubn ? "ubn=" + encodeURIComponent(String(input.ubn).replace(/\D/g, "")) : "q=" + encodeURIComponent(input.keyword || "");
      return await (await fetch(`${origin}/api/company?${q}`)).json();
    }
    case "brief_settings": {
      const s = await briefSettings(db, chatId);
      if (typeof input.on === "boolean") s.on = input.on;
      if (/^\d{2}:\d{2}$/.test(input.time || "")) s.time = input.time;
      if (input.roles?.length) s.roles = input.roles.filter(r => ROLE_NAMES[r]);
      await kv.set(db, "brief:" + chatId, JSON.stringify(s));
      return { ...s, note: isGroup(chatId) ? "群組早報每天發一則，會依群組人數計入官方帳號的每月訊息則數" : "" };
    }
  }
  return { error: "沒有這個工具" };
}

export async function briefSettings(db, chatId) {
  return { on: false, time: "08:00", roles: ["company", "person"], last: "", ...(await kv.json(db, "brief:" + chatId, {})) };
}

/* ---------- Claude ---------- */
function systemPrompt(ctx) {
  const now = Date.now();
  const where = isGroup(ctx.chatId) ? `你在 LINE 群組「${ctx.chatName || "工作群組"}」裡，現在跟你說話的是「${ctx.userName}」。群組裡大家都能叫你。` : `你在和「${ctx.userName}」一對一聊天。`;
  const o = ctx.origin;
  return `你是 LINE 上的工作小助理，幫忙回答問題、整理群組討論、管理待辦和提醒，特別熟悉台灣的稅務、勞健保與公司行政。
${where}
現在是台北時間 ${ymd(now)}（星期${WEEK[tp(now).getUTCDay()]}）${hm(now)}。

做事原則：
- 需要資料時用工具，不要編造。日期說「明天」「下週五」要換算成實際日期。
- 總結群組討論時先用 read_chat，分成「重點」「決定事項」「待辦（誰／做什麼／何時）」三段，沒有就寫「沒有」；最後問要不要把待辦加入清單，使用者同意才用 add_todos。
- 只轉述聊天紀錄裡真的有的內容；不確定誰負責就寫「未指定」。不要評論個人、不要揣測私事。
- 提醒時間沒講幾點，預設早上 9 點並說明。在群組設提醒，預設發在群組；說「私訊我」才用 target=me。
${ctx.book ? `- 這個群組綁定了記帳表「${ctx.book.name}」，欄位：${ctx.book.headers.join("、")}。有人請你記帳時：先用 book_info 看欄位和最近的寫法，再用 propose_rows 列出（欄位名稱完全照表頭、日期 YYYY-MM-DD、金額只寫數字），系統會讓人按「確認」才寫入；確認前不要說「已記帳」。說「這張」「剛剛的單據」時用 recent_photos 讀照片。資訊不足（例如金額、品項）先問。` : "- 這個聊天室沒有綁定記帳表；有人要記帳，請管理員在群組輸入「/設定記帳」。"}
- 除了綁定的記帳表，你不處理任何人的帳務或個人財務資料。
- 稅務、勞健保、法規依台灣現行規定回答，提醒「試算僅供參考，以主管機關核定為準」；適合的話附上工具連結：
  綜所稅 ${o}/income-tax/ 、勞健保 ${o}/labor-health/ 、房東報稅 ${o}/landlord-tax/ 、營業稅 ${o}/vat/ 、報稅行事曆 ${o}/tax-calendar/ 、統編查詢 ${o}/company-lookup/ 。
- 不確定就說不確定。

回覆格式（LINE 不支援 Markdown）：
- 繁體中文、口語、簡短。群組裡尤其精簡，通常 2～10 行。
- 不要用 #、**、表格、程式碼區塊。條列用「・」，金額加千分位。`;
}

async function claude(env, body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error("Claude " + r.status + " " + (j.error?.message || "")); e.status = r.status; throw e; }
  return j;
}

export async function chat(ctx, userContent, logText) {
  const { env, db, chatId } = ctx;
  const { results } = await db.prepare("SELECT role,text FROM line_history WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 12").bind(chatId, Date.now() - DAY).all();
  const messages = [];
  for (const h of results.reverse()) {
    const role = h.role === "user" ? "user" : "assistant";
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += "\n" + h.text;
    else messages.push({ role, content: h.text });
  }
  if (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length && messages[messages.length - 1].role === "user") messages.push({ role: "assistant", content: "（好的）" });
  // 群組裡附上最近的對話，讓「剛剛說的那個」看得懂
  if (isGroup(chatId)) {
    const { results: recent } = await db.prepare("SELECT name,text FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 20").bind(chatId, Date.now() - 6 * HOUR).all();
    if (recent.length) userContent = [{ type: "text", text: "（群組最近的對話，供參考）\n" + recent.reverse().map(r => `${r.name}：${r.text}`).join("\n").slice(-4000) }, ...userContent];
  }
  messages.push({ role: "user", content: userContent });

  const all = ctx.book ? [...TOOLS, ...BOOK_TOOLS] : TOOLS;
  const tools = all.map((t, i) => i === all.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t);
  const system = [{ type: "text", text: systemPrompt(ctx) }];
  const model = env.CLAUDE_MODEL || "claude-haiku-5-5";
  let text = "";
  for (let round = 0; round < 6; round++) {
    const res = await claude(env, { model, max_tokens: 1500, system, tools, messages });
    const blocks = res.content || [];
    text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (res.stop_reason !== "tool_use") break;
    messages.push({ role: "assistant", content: blocks });
    const out = [];
    for (const b of blocks.filter(b => b.type === "tool_use")) {
      let r;
      try { r = await runTool(ctx, b.name, b.input || {}); } catch (e) { r = { error: e.message }; }
      out.push({ type: "tool_result", tool_use_id: b.id, content: r && r.__blocks ? r.__blocks : JSON.stringify(r).slice(0, 70000) });
    }
    messages.push({ role: "user", content: out });
  }
  text = cleanText(text) || (ctx.pending ? "請確認：" : "我沒有聽懂，可以換個說法嗎？");
  if (ctx.pending && !text.includes(ctx.pending.summary.slice(0, 15))) text += "\n\n" + ctx.pending.summary;
  const who = isGroup(chatId) ? `${ctx.userName}：` : "";
  await db.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").bind(chatId, "user", (who + logText).slice(0, 2000), Date.now()).run();
  await db.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").bind(chatId, "assistant", text.slice(0, 2000), Date.now()).run();
  return { text, pending: ctx.pending || null };
}

export function cleanText(t) {
  return String(t || "").replace(/^#{1,6}\s*/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^\s*[-*]\s+/gm, "・").replace(/`{1,3}/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- 不用 AI 的快速指令 ---------- */
export async function todoText(db, chatId) {
  const { results } = await db.prepare("SELECT * FROM line_todos WHERE chat_id=? AND status='open' ORDER BY due IS NULL, due LIMIT 30").bind(chatId).all();
  if (!results.length) return "目前沒有待辦。\n要新增可以說：「@小助理 待辦：週五前交報價單，負責人小王」";
  return "📋 待辦清單\n" + results.map(t => `・[${t.id}] ${t.task}${t.assignee_name ? "（" + t.assignee_name + "）" : ""}${t.due ? "｜" + when(t.due) + (t.due < Date.now() ? " ⚠ 已過期" : "") : ""}`).join("\n")
    + "\n\n完成的話說「完成 編號」，例如「完成 " + results[0].id + "」。";
}
export async function completeByText(db, chatId, text) {
  const ids = (text.match(/[0-9a-f]{4}/gi) || []).slice(0, 10);
  const done = [];
  for (const id of ids) {
    const r = await db.prepare("UPDATE line_todos SET status='done' WHERE id=? AND chat_id=? AND status='open'").bind(id.toLowerCase(), chatId).run();
    if ((r.meta?.changes ?? 1) > 0) { done.push(id); await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE todo_id=? AND status='open'").bind(id.toLowerCase()).run(); }
  }
  return done.length ? `✓ 已完成：${done.join("、")}` : "找不到這個待辦編號，可以輸入「/待辦」看清單。";
}

/* ---------- 每日早報（固定格式，不用 AI） ---------- */
export async function composeBrief(env, db, chatId, origin) {
  const s = await briefSettings(db, chatId), now = Date.now();
  const parts = [`早安！${mdw(now)}今日重點`];
  try {
    const ds = await deadlines(env, origin, 7, s.roles);
    parts.push("📅 報稅期限（7 天內）\n" + (ds.length ? ds.slice(0, 6).map(d => `・${md(d.due)} ${d.title}`).join("\n") : "・沒有"));
  } catch (e) { parts.push("📅 報稅期限：讀取失敗"); }
  const end = parseLocal(ymd(now) + "T23:59");
  const { results: todos } = await db.prepare("SELECT * FROM line_todos WHERE chat_id=? AND status='open' AND due IS NOT NULL AND due<=? ORDER BY due").bind(chatId, end).all();
  if (todos.length) parts.push("📋 今天到期或已過期的待辦\n" + todos.map(t => `・${t.task}${t.assignee_name ? "（" + t.assignee_name + "）" : ""}${t.due < parseLocal(ymd(now)) ? " ⚠ 已過期" : ""}`).join("\n"));
  const { results: rs } = await db.prepare("SELECT due,text FROM line_reminders WHERE chat_id=? AND status='open' AND todo_id IS NULL AND due<=? ORDER BY due").bind(chatId, end).all();
  if (rs.length) parts.push("⏰ 今天的提醒\n" + rs.map(r => `・${hm(r.due)} ${r.text}`).join("\n"));
  return parts.join("\n\n");
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
export const HELP_GROUP = `我是群組小助理，@我 或用「/」開頭的指令叫我：
・/總結：整理最近 24 小時的討論（重點、決定、待辦）
・/待辦：看待辦清單；「完成 編號」標成完成
・@小助理 待辦：週五前交報價單，負責人小王
・@小助理 明天下午 3 點提醒大家開會
・@小助理 11 月有什麼要報的？／查統編 22099131
・/早報：每天早上傳報稅期限和到期待辦（再說一次就關閉）
・記帳（綁定記帳表的群組）：「@小助理 記帳：碳粉 2 盒 3,200」，或先傳單據照片再說「@小助理 記這張」，按確認才寫入
・/記帳表：看這個群組的記帳表連結
・/不要記錄我、/恢復記錄、/清除紀錄`;
export const HELP_USER = `我是工作小助理，直接打字問我就好：
・稅務、勞健保問題：「月薪 4 萬勞健保自付多少」
・報稅期限：「這個月有什麼要報的」
・查公司：「查統編 22099131」
・提醒：「明天早上 9 點提醒我回電王會計」「每月 5 號提醒我繳房租」
・待辦：「待辦：週五前寄合約」，輸入「/待辦」看清單
把我拉進工作群組，可以幫大家整理討論、追蹤待辦。`;
export const JOIN_NOTICE = `大家好，我是工作小助理 👋
為了幫大家整理討論，我會記錄這個群組的文字訊息 ${KEEP_DAYS} 天，只用來做總結、待辦和提醒；整理時會交給 AI（Anthropic Claude）處理，不會用在其他地方。
・不想被記錄：輸入「/不要記錄我」
・清除這個群組的紀錄：輸入「/清除紀錄」
・把我移出群組，所有紀錄都會刪除

` + HELP_GROUP;
