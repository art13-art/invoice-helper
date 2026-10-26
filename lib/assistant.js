// LINE 群組助理：群組裡每個人都能用。不碰任何人的帳本或個人財務資料。
// Claude 負責理解與回答；工具負責讀群組紀錄做總結、待辦、提醒，
// 以及廠商群組的記帳（寫進該群組綁定的雲端試算表，按確認才寫入）。
import { BOOK_TOOLS, runBookTool } from "./books.js";
import { recordAI, checkBudget, buildReport, budgetUSD } from "./usage.js";

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
  { name: "remember", description: "記住管理員教的事（所有群組都適用）。如果跟已記住的某條是同一件事，傳 replaces 取代那一條，不要重複新增。",
    input_schema: { type: "object", properties: { text: { type: "string", description: "要記住的內容，寫成一句清楚完整的話" }, replaces: { type: "string", description: "要取代的舊記憶編號（同一件事時）" } }, required: ["text"] } },
  { name: "forget", description: "刪掉一條記住的事（用編號）。", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];
export async function memories(db) {
  const { results } = await db.prepare("SELECT id,text FROM line_memory ORDER BY updated LIMIT 80").all();
  return results;
}
/* 會改變資料的工具：完成後在對話紀錄留一行，避免之後重做 */
const WRITE_TOOLS = {
  set_reminder: (i, r) => `設定提醒 ${r.when} ${i.text}`,
  add_todos: (i, r) => "新增待辦 " + (r.added || []).map(t => t.task).join("、"),
  complete_todos: (i, r) => "劃掉待辦 " + (r.done || []).join("、"),
  cancel_reminder: i => "取消提醒 " + i.id,
  remember: i => "記住 " + i.text,
  forget: i => "刪除記憶 " + i.id,
  propose_rows: () => "列出待確認的帳",
};
const COST_TOOL = { name: "assistant_cost", description: "查小助理自己的使用費用（AI token 費用、回覆次數、LINE 主動訊息），只有管理員能用。",
  input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM，預設本月" } } } };
export const TOOLS = [
  { name: "read_chat", description: "讀這個群組最近的聊天紀錄（做總結、找誰說過什麼、整理待辦時用）。只有群組裡能用。",
    input_schema: { type: "object", properties: { hours: { type: "integer", description: "往回幾小時，預設 24，最多 720" } } } },
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
      mention: { type: "string", description: "提醒時要 @ 的成員名稱；「我」代表發問的人。只在群組有用" } }, required: ["when", "text"] } },
  { name: "list_reminders", description: "列出這個聊天室和發問者自己還沒到的提醒。", input_schema: { type: "object", properties: {} } },
  { name: "cancel_reminder", description: "取消提醒（用 list_reminders 的編號）。", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
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
  if (name === "remember") {
    if (!ctx.isAdmin) return { error: "只有管理員能教我記住事情" };
    const text = String(input.text || "").trim().slice(0, 300);
    if (!text) return { error: "沒有內容" };
    const now = Date.now();
    if (input.replaces) {
      const r = await db.prepare("UPDATE line_memory SET text=?, updated=?, created_by=? WHERE id=?").bind(text, now, userId, String(input.replaces)).run();
      if ((r.meta?.changes ?? 1) > 0) return { ok: true, updated: input.replaces, text };
    }
    const id = rid(4);
    await db.prepare("INSERT INTO line_memory(id,text,created_by,created,updated) VALUES(?,?,?,?,?)").bind(id, text, userId, now, now).run();
    return { ok: true, id, text, scope: "所有群組" };
  }
  if (name === "forget") {
    if (!ctx.isAdmin) return { error: "只有管理員能刪除記住的事" };
    const r = await db.prepare("DELETE FROM line_memory WHERE id=?").bind(String(input.id)).run();
    return { ok: (r.meta?.changes ?? 1) > 0 };
  }
  if (name === "assistant_cost") {
    if (!ctx.isAdmin) return { error: "只有管理員能看小助理的費用" };
    const m = /^\d{4}-\d{2}$/.test(input.month || "") ? input.month : ymd().slice(0, 7);
    return { ...(await buildReport(env, db, m)), note: "這是小助理（AI 與 LINE）本身的使用費用，不是任何人的帳務" };
  }
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
- 大家不會用指令，只會用平常講話的方式交辦或發問；自己判斷要做什麼，直接做完再簡短回報。
- 群組裡沒有 @你 的討論你都看得到（read_chat）；有人問「剛剛／之前說的…」「誰負責…」就去查紀錄回答。
- 有人交辦事情（例如「記得提醒他」「週五前要完成」），直接用 add_todos 或 set_reminder 記下來，不用再問要不要；只有負責人或時間真的不清楚才問一句。
- 有人說某件事「做完了」「交了」「搞定」，用 list_todos 找到對應的待辦再用 complete_todos 標完成，回一句「好，已劃掉」之類的就好。
- 對話紀錄裡標了［已完成：…］的事已經做過了，不要重做或重設；不確定有沒有設好就用 list_reminders／list_todos 查，不要憑印象說「其實沒設定」。
- 需要資料時用工具，不要編造。日期說「明天」「下週五」要換算成實際日期。
- 總結群組討論時先用 read_chat，分成重點、決定、待辦（誰／做什麼／何時），沒有的那段就省略；如果討論裡有明確的待辦（有人、有事），直接用 add_todos 加入並在最後列出；不明確的就列出來問一句。
- 只轉述聊天紀錄裡真的有的內容；不確定誰負責就寫「未指定」。不要評論個人、不要揣測私事。
- 提醒時間沒講幾點，預設早上 9 點並說明。在群組設提醒，預設發在群組；說「私訊我」才用 target=me。
${ctx.book ? `- 這個群組綁定了記帳表「${ctx.book.name}」，欄位：${ctx.book.headers.join("、")}。有人請你記帳時：先用 book_info 看欄位和最近的寫法，再用 propose_rows 列出（欄位名稱完全照表頭、日期 YYYY-MM-DD、金額只寫數字），系統會讓人按「確認」才寫入；確認前不要說「已記帳」。說「這張」「剛剛的單據」時用 recent_photos 讀照片。資訊不足（例如金額、品項）先問。` : "- 這個聊天室沒有綁定記帳表；有人要記帳，請管理員在群組 @你 說「設定記帳表」。"}
- 除了綁定的記帳表，你不處理任何人的帳務或個人財務資料。
${ctx.isAdmin ? "- 跟你說話的人是管理員。他問「你花了我多少錢」「目前花費」「用量」這類問題，指的是你（小助理）自己的 AI 使用費用，用 assistant_cost 查了再回答，金額同時寫美元和約台幣。" : ""}
- 不確定就說不確定。

說話方式：
- 像一個做事俐落的同事在 LINE 上回話：直接講重點，口語、自然，不客套。
- 不要開場白和結尾客套（不說「您好」「很高興為您服務」「還有什麼需要幫忙的嗎」），不自我介紹，不主動列出自己會做什麼。
- 稱呼用「你」，不用「您」。不要說自己是 AI 或機器人，也不要道歉一大串；做錯了就簡短說「抱歉，我更正」。
- 辦完事只回結果，一兩句就好，例如「好，週五早上 9 點提醒小陳交報價單。」
- 回答長度跟問題相稱：簡單問題一句話；整理討論才用條列。條列用「・」，不用 #、**、表格。
- 少用表情符號。繁體中文，金額加千分位。`;
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
    const { results: recent } = await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 21").bind(chatId, Date.now() - 6 * HOUR).all();
    if (recent.length && recent[0].text === ctx.rawText) recent.shift();   // 最新一則就是這次叫它的訊息
    if (recent.length) userContent = [{ type: "text", text: "（群組最近的對話，由舊到新）\n" + recent.reverse().map(r => `[${hm(r.ts)}] ${r.name}：${r.text}`).join("\n").slice(-4000) }, ...userContent];
  }
  messages.push({ role: "user", content: userContent });

  const all = [...TOOLS, ...(ctx.book ? BOOK_TOOLS : []), ...(ctx.isAdmin ? [COST_TOOL, ...MEMORY_TOOLS] : [])];
  const tools = all.map((t, i) => i === all.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t);
  const mem = await memories(db);
  const memText = mem.length ? "\n\n管理員教過你的事（所有群組都適用，回答時要遵守和參考）：\n" + mem.map(m => `[${m.id}] ${m.text}`).join("\n")
    : "";
  const teach = ctx.isAdmin ? "\n- 管理員說「記住…」「以後…都…」時用 remember 記下；跟上面某條是同一件事就用 replaces 更新那條。說「忘記…」用 forget。問「你記得什麼」就列出來。"
    : "\n- 有人要你「記住」規則或事情時，告訴他要請管理員教你。";
  const system = [{ type: "text", text: systemPrompt(ctx) + teach + memText }];
  const model = env.CLAUDE_MODEL || "claude-haiku-5-5";
  let text = "";
  const done = [];
  for (let round = 0; round < 6; round++) {
    const res = await claude(env, { model, max_tokens: 1500, system, tools, messages });
    if (res.usage) await recordAI(env, db, { chatId, userId: ctx.userId, model, usage: res.usage }).catch(e => console.log("usage", e.message));
    const blocks = res.content || [];
    text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
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
  await checkBudget(env, db).catch(e => console.log("budget", e.message));
  text = cleanText(text) || (ctx.pending ? "請確認：" : "我沒有聽懂，可以換個說法嗎？");
  if (ctx.pending && !text.includes(ctx.pending.summary.slice(0, 15))) text += "\n\n" + ctx.pending.summary;
  const who = isGroup(chatId) ? `${ctx.userName}：` : "";
  await db.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").bind(chatId, "user", (who + logText).slice(0, 2000), Date.now()).run();
  const note = done.length ? "\n［已完成：" + done.join("；") + "］" : "";
  await db.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").bind(chatId, "assistant", (text.slice(0, 1800) + note).slice(0, 2400), Date.now()).run();
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
    + "\n\n做完的跟我說一聲，例如「報價單交了」。";
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
・剛剛說的交期是哪天？`;
export const HELP_USER = `有事直接說就好，例如：
・明天早上 9 點提醒我回電王會計
・週五前要寄合約給客戶`;
export const JOIN_NOTICE = `大家好，我是小助理。交辦、提醒、問事情，@我 就好。
群組討論我會記 ${KEEP_DAYS} 天（由 AI 整理），之後可以隨時問我；不想被記錄的人跟我說「不要記錄我」。`;
