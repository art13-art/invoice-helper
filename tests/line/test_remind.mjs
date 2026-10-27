import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8")); try { sq.exec("ALTER TABLE line_memory ADD COLUMN chat_id TEXT"); } catch (e) {}
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
let pushes = [];
globalThis.fetch = async (url, init = {}) => { url = String(url); if (url.endsWith("/message/push")) pushes.push(JSON.parse(init.body));
  return new Response(JSON.stringify(url.includes("/count") ? { count: 3 } : {}), { status: 200 }); };
const env = { DB: db, LINE_CHANNEL_TOKEN: "t" };
const A = await import(R + "/lib/assistant.js");
const tick = await import(R + "/functions/api/line/tick.js");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const TP = (s) => Date.parse(s + "+08:00");
const fmt = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

// quiet hours
t(fmt(A.quiet(TP("2026-11-02T23:30"))) === "2026-11-03 08:00", "23:30 → next 08:00");
t(fmt(A.quiet(TP("2026-11-03T06:10"))) === "2026-11-03 08:00", "06:10 → 08:00");
t(fmt(A.quiet(TP("2026-11-03T14:30"))) === "2026-11-03 14:30", "daytime unchanged");
t(fmt(A.quiet(TP("2026-11-03T22:00"))) === "2026-11-04 08:00", "22:00 edge");
t(fmt(A.quiet(TP("2026-11-03T08:00"))) === "2026-11-03 08:00", "08:00 edge");

// add_todos → day-before 16:00 + due
const G = "Cg1", ctx = { env, db, chatId: G, userId: "U_boss", userName: "Ben" };
sq.prepare("INSERT INTO line_members VALUES(?,?,?,0,?)").run(G, "U_amy", "Amy", Date.now());
const day = n => new Date(Date.now() + 8 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
await A.runTool(ctx, "add_todos", { items: [{ task: "交報價單", assignee: "Amy", due: day(3) }] });
let rs = sq.prepare("SELECT due,text,mention_name FROM line_reminders ORDER BY due").all();
t(rs.length === 2 && rs[0].text === "明天到期：交報價單" && fmt(rs[0].due) === day(2) + " 16:00" && rs[0].mention_name === "Amy", "day-before 16:00 " + JSON.stringify(rs.map(r => [fmt(r.due), r.text])));
t(rs[1].text === "待辦到期：交報價單" && fmt(rs[1].due) === day(3) + " 09:00", "due 09:00");
// update_todo moves both
const tid = sq.prepare("SELECT id FROM line_todos").get().id;
await A.runTool(ctx, "update_todo", { id: tid, due: day(5) + "T17:00" });
rs = sq.prepare("SELECT due,text FROM line_reminders WHERE status='open' ORDER BY due").all();
t(rs.length === 2 && fmt(rs[0].due) === day(4) + " 16:00" && fmt(rs[1].due) === day(5) + " 17:00", "update_todo reschedules " + JSON.stringify(rs.map(r => fmt(r.due))));
// due tomorrow morning added in the evening (16:00 already passed today or not) → no past reminders
sq.exec("DELETE FROM line_reminders; DELETE FROM line_todos;");
await A.runTool(ctx, "add_todos", { items: [{ task: "回覆客戶", due: day(0) }] });
t(sq.prepare("SELECT count(*) n FROM line_reminders WHERE due < ?").get(Date.now() - 60e3).n === 0, "no past reminders");

// set_reminder auto → quiet shift; explicit time kept
sq.exec("DELETE FROM line_reminders;");
await A.runTool(ctx, "set_reminder", { when: day(2) + "T07:30", text: "30 分鐘後晨會", auto: true });
await A.runTool(ctx, "set_reminder", { when: day(2) + "T07:30", text: "我自己要的", });
rs = sq.prepare("SELECT due,text FROM line_reminders ORDER BY text").all();
t(rs.find(r => r.text === "30 分鐘後晨會") && fmt(rs.find(r => r.text === "30 分鐘後晨會").due) === day(2) + " 08:00", "auto shifted to 08:00");
t(fmt(rs.find(r => r.text === "我自己要的").due) === day(2) + " 07:30", "explicit kept");

// tick: due → overdue every day until done
sq.exec("DELETE FROM line_reminders; DELETE FROM line_todos; DELETE FROM line_kv;");
const now = Date.now();
sq.prepare("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES('ab12',?,?,'U_amy','Amy',?,'open',?,'U_boss')").run(G, "交排班", now - 60e3, now);
sq.prepare("INSERT INTO line_reminders VALUES('r0',?,?,'明天到期：交排班','none','U_amy','Amy','ab12',?,'U_boss','open',NULL)").run(G, now - 3 * 60e3, now);
sq.prepare("INSERT INTO line_reminders VALUES('r1',?,?,'待辦到期：交排班','none','U_amy','Amy','ab12',?,'U_boss','open',NULL)").run(G, now - 60e3, now);
const run = async () => { sq.prepare("DELETE FROM line_kv WHERE k='tick:last'").run(); pushes = []; await tick.onRequestPost({ request: new Request("https://x/api/line/tick", { method: "POST", body: "{}" }), env }); };
await run();
const od = () => sq.prepare("SELECT id,due,text FROM line_reminders WHERE status='open' AND text LIKE '逾期%'").all();
t(pushes.length === 2 && od().length === 1, "due sent, one overdue scheduled (day-before doesn't schedule) " + od().length);
t(fmt(od()[0].due).endsWith("09:00"), "overdue at 09:00");
// simulate 3 days of overdue
for (let i = 0; i < 3; i++) {
  sq.prepare("UPDATE line_reminders SET due=? WHERE status='open' AND text LIKE '逾期%'").run(Date.now() - 1000);
  sq.prepare("UPDATE line_todos SET due=? WHERE id='ab12'").run(Date.now() - (i + 1) * 864e5);
  await run();
  t(pushes.length === 1 && od().length === 1, `day ${i + 1}: pushed and re-scheduled`);
}
t(/逾期 3 天還沒完成：交排班/.test(JSON.stringify(pushes[0])), "overdue days in text " + JSON.stringify(pushes[0]?.messages?.[0]?.text));
// done stops it
sq.prepare("UPDATE line_todos SET status='done' WHERE id='ab12'").run();
sq.prepare("UPDATE line_reminders SET due=? WHERE status='open'").run(Date.now() - 1000);
await run();
t(pushes.length === 0 && od().length === 0, "stops after done");
console.log(`${ok} passed, ${bad} failed`);
