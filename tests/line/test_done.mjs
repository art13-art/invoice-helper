import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8")); try { sq.exec("ALTER TABLE line_memory ADD COLUMN chat_id TEXT"); } catch (e) {}
// D1 shim
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
const calls = [];
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  const j = String(url).includes("/member/") ? { displayName: String(url).endsWith("U_amy") ? "Amy" : "Bob" } : String(url).includes("/count") ? { count: 3 } : {};
  return new Response(JSON.stringify(j), { status: 200 }); };
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s" };
const G = "Cgroup1", now = Date.now();
const ins = (q, ...a) => sq.prepare(q).run(...a);
ins("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES('ab12',?,?,'U_amy','Amy',?,'open',?,'U_boss')", G, "交報價單", now - 60e3, now);
ins("INSERT INTO line_reminders VALUES('r1',?,?,?,'none','U_amy','Amy','ab12',?,'U_boss','open',NULL)", G, now - 60e3, "待辦到期：交報價單", now);
ins("INSERT INTO line_reminders VALUES('r2',?,?,?,'none',NULL,NULL,NULL,?,'U_boss','open',NULL)", G, now - 60e3, "三點開會", now);
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

const tick = await import(R + "/functions/api/line/tick.js");
await tick.onRequestPost({ request: new Request("https://x/api/line/tick", { method: "POST", body: "{}" }), env });
const pushes = calls.filter(c => c.url.endsWith("/message/push"));
t(pushes.length === 2, "two pushes " + pushes.length);
const todoPush = pushes.find(p => p.body.messages.length === 2), plain = pushes.find(p => p.body.messages.length === 1);
t(todoPush && todoPush.body.messages[1].type === "flex" && JSON.stringify(todoPush.body.messages[1]).includes("done:ab12"), "todo push has done card");
t(todoPush && todoPush.body.messages[0].type === "textV2", "mention kept");
t(plain && plain.body.messages[0].text.includes("三點開會"), "plain reminder unchanged, no card");
t(sq.prepare("SELECT count(*) n FROM line_reminders WHERE todo_id='ab12' AND text LIKE '逾期%' AND status='open'").get().n === 1, "overdue follow-up scheduled");

const wh = await import(R + "/functions/api/line/webhook.js");
const post = async (userId, data) => { const body = JSON.stringify({ events: [{ type: "postback", webhookEventId: Math.random() + "", replyToken: "rt", source: { type: "group", groupId: G, userId }, postback: { data } }] });
  const sig = createHmac("sha256", "s").update(body).digest("base64"); calls.length = 0;
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": sig } }), env });
  return calls.find(c => c.url.endsWith("/message/reply"))?.body.messages[0].text; };
let r = await post("U_other", "done:ab12");
t(/請本人按/.test(r) && sq.prepare("SELECT status FROM line_todos WHERE id='ab12'").get().status === "open", "other person blocked: " + r);
r = await post("U_amy", "done:ab12");
t(/Amy 完成了：交報價單/.test(r), "assignee completes: " + r);
t(sq.prepare("SELECT status FROM line_todos WHERE id='ab12'").get().status === "done", "todo done");
t(sq.prepare("SELECT count(*) n FROM line_reminders WHERE todo_id='ab12' AND status='open'").get().n === 0, "follow-up reminders cancelled");
t(sq.prepare("SELECT count(*) n FROM line_msgs WHERE text LIKE '［按了已完成%'").get().n === 1, "recorded for AI");
r = await post("U_amy", "done:ab12");
t(/已經完成/.test(r), "second press: " + r);
r = await post("U_amy", "done:ffff");
t(/找不到/.test(r), "unknown id");
// creator can complete; no-assignee todo anyone can
ins("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES('cd34',?,?,NULL,NULL,NULL,'open',?,'U_boss')", G, "訂便當", now);
r = await post("U_other", "done:cd34"); t(/完成了：訂便當/.test(r), "unassigned anyone: " + r);
// todo list chips
ins("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES('ef56',?,?,'U_amy','Amy',NULL,'open',?,'U_boss')", G, "寄樣品給廠商確認顏色和尺寸", now);
const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "m1", replyToken: "rt", source: { type: "group", groupId: G, userId: "U_amy" }, message: { type: "text", id: "1", text: "/待辦" } }] });
calls.length = 0;
await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64") } }), env });
const m = calls.find(c => c.url.endsWith("/message/reply"))?.body.messages[0];
t(m && m.quickReply?.items?.[0]?.action?.data === "done:ef56" && m.quickReply.items[0].action.label.length <= 20, "todo list chips " + JSON.stringify(m?.quickReply));
// other groups can't complete via forged id
const body2 = JSON.stringify({ events: [{ type: "postback", webhookEventId: "x9", replyToken: "rt", source: { type: "group", groupId: "Cother", userId: "U_amy" }, postback: { data: "done:ef56" } }] });
calls.length = 0;
await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body: body2, headers: { "x-line-signature": createHmac("sha256", "s").update(body2).digest("base64") } }), env });
t(sq.prepare("SELECT status FROM line_todos WHERE id='ef56'").get().status === "open", "cross-group blocked");
console.log(`${ok} passed, ${bad} failed`);
