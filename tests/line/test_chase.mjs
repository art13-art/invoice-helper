import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
sq.prepare("INSERT INTO line_kv VALUES('admins',?)").run(JSON.stringify(["U_ben"]));
for (const [u, n] of [["U_ben", "Ben"], ["U_amy", "Amy"]]) sq.prepare("INSERT INTO line_members VALUES('Cg',?,?,0,?)").run(u, n, Date.now());
let calls = [];
globalThis.fetch = async (url, init = {}) => { url = String(url); calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
  if (/\/member\//.test(url)) return new Response(JSON.stringify({ displayName: url.endsWith("U_ben") ? "Ben" : "Amy" }));
  if (url.includes("/count")) return new Response(JSON.stringify({ count: 3 }));
  if (url.includes("anthropic")) return new Response(JSON.stringify({ content: [{ type: "text", text: "好。" }], stop_reason: "end_turn", usage: {} }));
  return new Response("{}"); };
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
const tick = await import(R + "/functions/api/line/tick.js");
let n = 0;
const msg = async (u, text, mentionees) => { const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "e" + n++, replyToken: "rt", source: { type: "group", groupId: "Cg", userId: u }, message: { type: "text", id: "m" + n, text, ...(mentionees ? { mention: { mentionees } } : {}) } }] });
  calls = []; await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env }); };
const chases = () => sq.prepare("SELECT * FROM line_reminders WHERE kind='chase' AND status='open'").all();
const runTick = async () => { sq.prepare("DELETE FROM line_kv WHERE k='tick:last'").run(); sq.prepare("UPDATE line_reminders SET due=? WHERE status='open'").run(Date.now() - 1000); calls = []; await tick.onRequestPost({ request: new Request("https://x/api/line/tick", { method: "POST", body: "{}" }), env }); return calls.filter(c => c.url.endsWith("/message/push")); };
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

await msg("U_amy", "@Ben 這份報價可以幫我確認嗎", [{ index: 0, length: 4, type: "user", userId: "U_ben" }]);
let c = chases();
t(c.length === 1 && c[0].mention_id === "U_ben" && /Amy .* 找你：「@Ben 這份報價可以幫我確認嗎」/.test(c[0].text), "@Ben starts chase " + JSON.stringify(c));
const hrs = (c[0].due - Date.now()) / 3600e3; t(hrs > 2.9 || new Date(c[0].due + 8 * 3600e3).getUTCHours() === 8, "3 hours later (or 08:00 if night)");
await msg("U_amy", "Ben 預算那個也麻煩看一下");
c = chases(); t(c.length === 1 && /（共 2 件）/.test(c[0].text), "name + ask merges " + c[0]?.text);
await msg("U_amy", "Ben 今天好帥");
c = chases(); t(/（共 2 件）/.test(c[0].text), "name without ask ignored");
await msg("U_amy", "大家好");
t(chases().length === 1, "unrelated ignored");
// Ben 回了 → 取消
await msg("U_ben", "我看一下");
t(chases().length === 0, "admin reply cancels");
// 沒回 → 3 小時後 @Ben
await msg("U_amy", "@Ben 合約要簽", [{ index: 0, length: 4, type: "user", userId: "U_ben" }]);
let p = await runTick();
const m = p[0]?.body.messages[0];
t(p.length === 1 && m.type === "textV2" && m.substitution.m0.mentionee.userId === "U_ben" && !m.text.includes("⏰") && /合約要簽/.test(m.text), "chase sent " + JSON.stringify(m));
p = await runTick(); t(p.length === 0, "only once");
// 小幫手自己 @Ben 也會追
await msg("U_amy", "@小幫手 記住以後不要提醒 Tom", [{ index: 0, length: 4, isSelf: true }]);
// (Claude mock answers plain; escalate via ask path tested elsewhere) — call toAdmin directly
const { toAdmin } = await import(R + "/lib/escalate.js");
await toAdmin(env, db, { chatId: "Cg", adm: { id: "U_ben", name: "Ben", inChat: true }, text: "Amy 想讓我記住：「x」" });
c = chases(); t(c.length === 0, "plain relay to admin is not chased");
await toAdmin(env, db, { chatId: "Cg", adm: { id: "U_ben", name: "Ben", inChat: true }, text: "Amy 想讓我記住：「x」", card: { type: "flex" } });
c = chases(); t(c.length === 1 && /小幫手 .* 找你/.test(c[0].text), "decision card is chased");
await msg("U_amy", "助理，明天的資料幫我準備一下");
t(!calls.some(c => c.url.endsWith("/message/reply")), "「助理，」no longer triggers a reply");
await msg("U_amy", "小助理 幫我記一下");
t(!calls.some(c => c.url.endsWith("/message/reply")), "「小助理」no longer triggers");
await msg("U_amy", "@小幫手 在嗎", [{ index: 0, length: 4, isSelf: true }]);
t(calls.some(c => c.url.endsWith("/message/reply")), "@ still works");
sq.exec("UPDATE line_reminders SET status='cancelled' WHERE kind='chase'");
await msg("U_amy", "Ben，小幫手的設定你可以看一下嗎");
t(chases().length === 1, "naming Ben (not to bot) still chases");
// 電腦版：打字的「@小幫手」（沒有真正的 mention）也算叫它
await msg("U_amy", "@小幫手 在嗎");
t(calls.some(c => c.url.endsWith("/message/reply")), "typed @小幫手 gets a reply");
await msg("U_amy", "＠小幫手 幫我跟 Ben 說報價好了嗎");
t(chases().length === 1, "typed @小幫手 mentioning Ben is for the bot, no extra chase");
await msg("U_amy", "小幫手好用");
t(!calls.some(c => c.url.endsWith("/message/reply")), "just the name without @ doesn't trigger");
console.log(`${ok} passed, ${bad} failed`);
