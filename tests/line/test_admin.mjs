import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
try { sq.exec("ALTER TABLE line_memory ADD COLUMN chat_id TEXT"); } catch (e) {}
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
sq.prepare("INSERT INTO line_kv VALUES('admins',?)").run(JSON.stringify(["U_ben"]));
sq.prepare("INSERT INTO line_kv VALUES('gas:conf',?)").run(JSON.stringify({ url: "https://gas.example/exec", key: "k" }));
const groups = { Cg1: { U_ben: "Ben", U_amy: "Amy" }, Cg2: { U_amy: "Amy", U_tom: "Tom" } };
const names = { U_ben: "Ben", U_amy: "Amy", U_tom: "Tom" };
let calls = [], claudeSeen = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  let m = url.match(/\/group\/(\w+)\/member\/(\w+)/); if (m) return groups[m[1]]?.[m[2]] ? J({ displayName: groups[m[1]][m[2]] }) : J({}, 404);
  m = url.match(/\/profile\/(\w+)/); if (m) return J({ displayName: names[m[1]] });
  if (url.includes("/count")) return J({ count: 3 });
  if (url.startsWith("https://gas.example")) return J({ ok: true, result: { id: "S1", url: "https://sheet", name: "廠商帳｜測試", tab: "記帳", headers: ["日期", "品項"] } });
  if (url.includes("api.anthropic.com")) {
    claudeSeen.push(body);
    const s = JSON.stringify(body.messages.at(-1));
    if (!s.includes("tool_result")) {
      if (s.includes("記住穩")) return J({ content: [{ type: "tool_use", id: "t1", name: "remember", input: { text: "回覆時稱呼大家「各位」", sure: true } }], stop_reason: "tool_use", usage: {} });
      if (s.includes("記住險")) return J({ content: [{ type: "tool_use", id: "t2", name: "remember", input: { text: "以後不要提醒 Tom 任何事", sure: false, reason: "會影響別人" } }], stop_reason: "tool_use", usage: {} });
      if (s.includes("花多少")) return J({ content: [{ type: "tool_use", id: "t3", name: "assistant_cost", input: {} }], stop_reason: "tool_use", usage: {} });
    }
    return J({ content: [{ type: "text", text: "好的。" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0, lastMsgs = [];
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls = []; claudeSeen = [];
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); lastMsgs = r ? r.body.messages : []; return lastMsgs; };
const say = (g, u, text) => send({ type: "message", source: { type: "group", groupId: g, userId: u }, message: { type: "text", id: "m" + n, text: "@小幫手 " + text, mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
const press = (src, data) => send({ type: "postback", source: src, postback: { data } });
const txt = ms => ms.map(m => m.text || JSON.stringify(m)).join("\n");
const pushes = () => calls.filter(c => c.url.endsWith("/message/push"));
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

// 1. 非管理員、確定的 → 直接記在這個群組
await say("Cg1", "U_amy", "記住穩");
let mem = sq.prepare("SELECT text,chat_id FROM line_memory").all();
t(mem.length === 1 && mem[0].chat_id === "Cg1", "sure → saved to this group " + JSON.stringify(mem));
t(!/管理員/.test(txt(lastMsgs)), "no 管理員 wording");
// 只在本群看得到
await say("Cg2", "U_amy", "隨便問");
t(!JSON.stringify(claudeSeen[0].system).includes("各位"), "other group doesn't see it");
await say("Cg1", "U_amy", "隨便問");
t(JSON.stringify(claudeSeen[0].system).includes("〔本聊天室〕 回覆時稱呼大家「各位」"), "this group sees it");

// 2. 不確定的 → 在群組 @Ben + 按鈕
let ms = await say("Cg1", "U_amy", "記住險");
const mention = ms.find(m => m.type === "textV2"), card = ms.find(m => m.type === "flex");
t(mention && mention.substitution.m0.mentionee.userId === "U_ben" && /Amy 想讓我記住：「以後不要提醒 Tom 任何事」/.test(mention.text), "@Ben with request " + JSON.stringify(mention));
t(card && /adm:ok:\w+/.test(JSON.stringify(card)) && /adm:all:/.test(JSON.stringify(card)), "decision card");
t(sq.prepare("SELECT count(*) n FROM line_memory").get().n === 1, "not saved yet");
t(/還沒記/.test(JSON.stringify(claudeSeen.at(-1))), "AI told it's pending");
const did = JSON.stringify(card).match(/adm:ok:(\w+)/)[1];
ms = await press({ type: "group", groupId: "Cg1", userId: "U_amy" }, "adm:ok:" + did);
t(/等 Ben 決定/.test(txt(ms)), "non-admin can't decide: " + txt(ms));
ms = await press({ type: "group", groupId: "Cg1", userId: "U_ben" }, "adm:all:" + did);
t(/所有群組都套用/.test(txt(ms)) && sq.prepare("SELECT chat_id FROM line_memory WHERE text LIKE '以後不要%'").get()?.chat_id === null, "admin → all groups");
ms = await press({ type: "group", groupId: "Cg1", userId: "U_ben" }, "adm:no:" + did);
t(/已經設定好/.test(txt(ms)), "second decision blocked");

// 3. Ben 不在的群組 → 私訊 Ben；Ben 在私訊按 → 結果也推回群組
ms = await say("Cg2", "U_amy", "記住險");
let p = pushes();
t(p.length === 1 && p[0].body.to === "U_ben" && /（.*）Amy 想讓我記住/.test(p[0].body.messages[0].text) && p[0].body.messages[1].type === "flex", "DM Ben when not in group");
t(!ms.some(m => m.type === "textV2"), "no mention in group without Ben");
const did2 = JSON.stringify(p[0].body.messages[1]).match(/adm:ok:(\w+)/)[1];
ms = await press({ type: "user", userId: "U_ben" }, "adm:ok:" + did2);
t(/只用在這個群組/.test(txt(ms)) && pushes().some(x => x.body.to === "Cg2"), "decided in DM, group informed");
t(sq.prepare("SELECT count(*) n FROM line_memory WHERE chat_id='Cg2'").get().n === 1, "scoped to Cg2");

// 4. 非管理員設定記帳表 → @Ben；按設定就綁好
ms = await say("Cg1", "U_amy", "設定記帳表");
t(/我請 Ben 確認/.test(txt(ms)) && ms.some(m => m.type === "textV2") && ms.some(m => m.type === "flex"), "book request → @Ben " + txt(ms).slice(0, 80));
const bid = JSON.stringify(ms.find(m => m.type === "flex")).match(/adm:ok:(\w+)/)[1];
ms = await press({ type: "group", groupId: "Cg1", userId: "U_ben" }, "adm:ok:" + bid);
t(/已建立記帳表/.test(txt(ms)) && sq.prepare("SELECT created_by FROM line_books WHERE chat_id='Cg1'").get()?.created_by === "U_amy", "book set after approval");

// 5. 費用 → @Ben
ms = await say("Cg1", "U_amy", "小幫手這個月花多少");
t(ms.some(m => m.type === "textV2" && /Amy 想知道小幫手這個月花了多少/.test(m.text)), "cost question → @Ben");

// 6. 管理員自己記 → 所有群組
await say("Cg1", "U_ben", "記住穩");
t(sq.prepare("SELECT chat_id FROM line_memory WHERE created_by='U_ben'").get()?.chat_id === null, "admin memory global");

// 7. 舊說法不見了
const src = readFileSync(R + "/lib/assistant.js", "utf8") + readFileSync(R + "/functions/api/line/webhook.js", "utf8") + readFileSync(R + "/lib/audio.js", "utf8") + readFileSync(R + "/lib/books.js", "utf8");
t(!/請管理員|只有管理員(可以|能)|告訴他要請管理員/.test(src.replace(/\/\/.*$/gm, "").replace(/description: "[^"]*"/g, "")), "no 'ask the admin' phrasing left");
console.log(`${ok} passed, ${bad} failed`);
