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
sq.prepare("INSERT INTO line_kv VALUES('name:Cad','96廣告分析')").run();
sq.prepare("INSERT INTO line_kv VALUES('name:Cxx','種樹行政作業')").run();
for (const [c, u, n] of [["Cad", "U_amy", "Amy"], ["Cad", "U_tom", "Tom"], ["Cad", "U_ben", "Ben"]]) sq.prepare("INSERT INTO line_members VALUES(?,?,?,0,?)").run(c, u, n, Date.now());
const groups = { Cad: ["U_amy", "U_tom", "U_ben", "U_bw"], Cxx: ["U_ben"] };
let calls = [], toolPlan = null, reply = "這是一段比較長的回答，用來測試下面會不會出現詳細分析的按鈕，內容要超過六十個字才會出現按鈕，所以這裡多寫一些字，再多補幾句讓它超過門檻。";
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  let m = url.match(/\/group\/(\w+)\/member\/(\w+)/); if (m) return groups[m[1]]?.includes(m[2]) ? J({ displayName: m[2].slice(2) }) : J({}, 404);
  if (/\/profile\//.test(url)) return J({ displayName: "X" });
  if (url.includes("/count")) return J({ count: 3 });
  if (url.includes("api.anthropic.com")) {
    if (toolPlan && !JSON.stringify(body.messages.at(-1)).includes("tool_result")) { const p = toolPlan; toolPlan = null; return J({ content: [{ type: "tool_use", id: "x", name: p.name, input: p.input }], stop_reason: "tool_use", usage: {} }); }
    lastTool = JSON.stringify(body.messages.at(-1));
    return J({ content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  }
  return J({});
};
let lastTool = "";
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const { mentionMessage } = await import(R + "/lib/line.js");
const wh = await import(R + "/functions/api/line/webhook.js");
const tick = await import(R + "/functions/api/line/tick.js");
let n = 0, lastMsgs = [];
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls = [];
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); lastMsgs = r ? r.body.messages : []; return lastMsgs; };
const sayG = (u, text) => send({ type: "message", source: { type: "group", groupId: "Cad", userId: u }, message: { type: "text", id: "m" + n, text: "@小幫手 " + text, mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
const sayDM = (u, text) => send({ type: "message", source: { type: "user", userId: u }, message: { type: "text", id: "m" + n, text } });
const runTick = async () => { sq.prepare("DELETE FROM line_kv WHERE k='tick:last'").run(); sq.prepare("UPDATE line_reminders SET due=? WHERE status='open'").run(Date.now() - 1000); calls = []; await tick.onRequestPost({ request: new Request("https://x/api/line/tick", { method: "POST", body: "{}" }), env }); return calls.filter(c => c.url.endsWith("/message/push")); };
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const day = new Date(Date.now() + 8 * 3600e3 + 864e5).toISOString().slice(0, 10);

// mentionMessage
let m = mentionMessage("⏰ {who} 交報表 {記得}", "U1,U2");
t(m.text === "⏰ {m0} {m1} 交報表 ｛記得｝" && m.substitution.m1.mentionee.userId === "U2", "multi + braces " + JSON.stringify(m));
m = mentionMessage("⏰ {who} 開會", "all"); t(m.substitution.m0.mentionee.type === "all", "all");
t(mentionMessage("⏰ {who} x", null).type === "text", "none → plain");

// 群組：多人、全體、沒指定 → 我
toolPlan = { name: "set_reminder", input: { when: day + "T10:00", text: "交素材", mention: "Amy、Tom" } }; await sayG("U_ben", "提醒 Amy 跟 Tom 明天交素材");
toolPlan = { name: "set_reminder", input: { when: day + "T14:00", text: "週會", mention: "全部" } }; await sayG("U_ben", "提醒大家明天週會");
toolPlan = { name: "set_reminder", input: { when: day + "T16:00", text: "回電" } }; await sayG("U_amy", "提醒我回電");
let rs = sq.prepare("SELECT text,mention_id,mention_name FROM line_reminders ORDER BY due").all();
t(rs[0].mention_id === "U_amy,U_tom" && rs[0].mention_name === "Amy、Tom", "two people " + JSON.stringify(rs[0]));
t(rs[1].mention_id === "all", "all"); t(rs[2].mention_id === "U_amy", "default me");
let p = await runTick();
const tv = p.map(x => x.body.messages[0]);
t(tv.length === 3 && tv.every(x => x.type === "textV2"), "all pushed as mentions");
t(tv.some(x => x.substitution.m0?.mentionee?.type === "all" && x.text.includes("週會")), "@All sent");
t(tv.some(x => Object.keys(x.substitution).length === 2), "two mentions sent");

// 私訊排程到別的群組 → 先給群組按鈕，點了才建立
sq.exec("DELETE FROM line_reminders");
const pressDM = (u, data) => send({ type: "postback", source: { type: "user", userId: u }, postback: { data } });
toolPlan = { name: "set_reminder", input: { when: day + "T09:00", text: "請大家今天下班前上傳本週素材", group: "廣告分析", mention: "全部", kind: "message" } };
await sayDM("U_amy", "明天 9 點在廣告群公告請大家上傳素材");
t(sq.prepare("SELECT count(*) n FROM line_reminders").get().n === 0, "not created before picking");
let picker = lastMsgs.find(x => x.type === "flex"), btns = picker?.contents.footer.contents || [];
t(btns.length === 1 && btns[0].action.label === "96廣告分析" && btns[0].style === "primary", "picker lists only Amy's groups, best first " + JSON.stringify(btns.map(b => b.action.label)));
t(!(lastMsgs[0].quickReply?.items || []).some(i => i.action.text === "/詳細分析"), "no chip with picker");
let res = (await pressDM("U_amy", btns[0].action.data))[0].text;
let r = sq.prepare("SELECT chat_id,kind,mention_id,created_by FROM line_reminders").get();
t(r && r.chat_id === "Cad" && r.kind === "msg" && r.mention_id === "all" && r.created_by === "U_amy", "created after pick " + JSON.stringify(r));
t(/✓ 已設定在「96廣告分析」（到時代發這則訊息）/.test(res) && /@全體：請大家今天下班前上傳本週素材/.test(res), "confirmation " + res);
res = (await pressDM("U_amy", btns[0].action.data))[0].text; t(/已經設定好/.test(res), "double press");
res = (await pressDM("U_tom", btns[0].action.data))[0].text; t(/別人/.test(res), "other user can't press");
p = await runTick();
t(p.length === 1 && p[0].body.to === "Cad" && !p[0].body.messages[0].text.includes("⏰"), "message sent without ⏰");
// 管理員看得到所有群組
toolPlan = { name: "set_reminder", input: { when: day + "T09:00", text: "y", group: "種樹" } };
await sayDM("U_ben", "在種樹群提醒");
btns = lastMsgs.find(x => x.type === "flex").contents.footer.contents;
t(btns.length === 2 && btns[0].action.label === "種樹行政作業", "admin sees all, best first " + JSON.stringify(btns.map(b => b.action.label)));
// 搬移：兩個提醒併成一張卡
sq.exec("DELETE FROM line_reminders");
sq.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES('w1','U_ben',?,'週會前一天','weekly',NULL,NULL,NULL,?,'U_ben','open',NULL)").run(Date.now() + 864e5, Date.now());
sq.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES('w2','U_ben',?,'30 分鐘後週會','weekly',NULL,NULL,NULL,?,'U_ben','open',NULL)").run(Date.now() + 2 * 864e5, Date.now());
const realFetch2 = globalThis.fetch;
let plans = [{ name: "update_reminder", input: { id: "w1", group: "廣告", mention: "全部" } }, { name: "update_reminder", input: { id: "w2", group: "廣告", mention: "全部" } }];
toolPlan = null;
globalThis.fetch = async (url, init) => { if (String(url).includes("anthropic") && plans.length && !String(init.body).includes("tool_result")) { const ps = plans; plans = []; return new Response(JSON.stringify({ content: ps.map((p, i) => ({ type: "tool_use", id: "u" + i, name: p.name, input: p.input })), stop_reason: "tool_use", usage: {} })); } return realFetch2(url, init); };
await sayDM("U_ben", "把週會提醒搬到廣告群，@全部");
globalThis.fetch = realFetch2;
const cards = lastMsgs.filter(x => x.type === "flex");
t(cards.length === 1, "two moves → one card");
res = (await pressDM("U_ben", cards[0].contents.footer.contents[0].action.data))[0].text;
const moved = sq.prepare("SELECT chat_id,mention_id FROM line_reminders ORDER BY id").all();
t(moved.every(x => x.chat_id === "Cad" && x.mention_id === "all") && /已搬到「96廣告分析」/.test(res) && /週會前一天/.test(res) && /30 分鐘後週會/.test(res), "moved both " + res);
// 被 @ 的人不在群組 → 不發；部分在 → 只 @ 在的
sq.exec("DELETE FROM line_reminders");
sq.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES('g1','Cad',?,'交報表','none','U_gone','Gone',NULL,?,'U_ben','open',NULL)").run(Date.now(), Date.now());
sq.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES('g2','Cad',?,'交素材','none','U_gone,U_amy','Gone、Amy',NULL,?,'U_ben','open',NULL)").run(Date.now(), Date.now());
// LINE 暫時出錯（500）不算退群
sq.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES('g3','Cad',?,'500 也要發','none','U_flaky','Flaky',NULL,?,'U_ben','open',NULL)").run(Date.now(), Date.now());
const rf = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).includes("/member/U_flaky") ? new Response("{}", { status: 500 }) : rf(url, init);
p = await runTick(); globalThis.fetch = rf;
t(p.some(x => /500 也要發/.test(x.body.messages[0].text)), "transient error doesn't skip");
p = p.filter(x => !/500 也要發/.test(x.body.messages[0].text));
t(p.length === 1 && Object.keys(p[0].body.messages[0].substitution).length === 1 && p[0].body.messages[0].substitution.m0.mentionee.userId === "U_amy", "only members tagged, left-only skipped " + JSON.stringify(p.map(x => x.body.messages[0])));
// 詳細分析按鈕
await sayG("U_amy", "這個標題好嗎");
let qr = lastMsgs.at(-1).quickReply?.items?.map(i => i.action.text) || [];
t(qr.includes("/詳細分析"), "chip shown " + JSON.stringify(qr));
reply = "好。"; await sayG("U_amy", "收到"); qr = lastMsgs.at(-1).quickReply?.items?.map(i => i.action.text) || [];
t(!qr.includes("/詳細分析"), "no chip on short reply");
reply = "這是一段比較長的回答，用來測試下面會不會出現詳細分析的按鈕，內容要超過六十個字才會出現按鈕，所以這裡多寫一些字，再多補幾句讓它超過門檻。";
await send({ type: "message", source: { type: "group", groupId: "Cad", userId: "U_amy" }, message: { type: "text", id: "mm", text: "/詳細分析" } });
qr = lastMsgs.at(-1).quickReply?.items?.map(i => i.action.text) || [];
t(/展開成詳細分析/.test(lastTool) && !qr.includes("/詳細分析"), "pressing it → deep, no chip again");
// 名字有空白
sq.prepare("INSERT INTO line_members VALUES('Cad','U_bw','Ben Wu',0,?)").run(Date.now());
sq.exec("DELETE FROM line_reminders");
toolPlan = { name: "set_reminder", input: { when: day + "T10:00", text: "看報表", mention: "Ben Wu" } }; await sayG("U_amy", "提醒 Ben Wu 看報表");
t(sq.prepare("SELECT mention_id FROM line_reminders WHERE kind IS NULL").get()?.mention_id === "U_bw", "name with space");
t(sq.prepare("SELECT count(*) n FROM line_reminders WHERE kind='chase'").get().n === 0, "talking to the bot about Ben doesn't chase Ben");
// LINE 拒收 @ → 純文字重送
const realFetch = globalThis.fetch; let tries = 0;
globalThis.fetch = async (url, init) => { if (String(url).endsWith("/message/push") && ++tries === 1) return new Response(JSON.stringify({ message: "invalid mentionee" }), { status: 400 }); return realFetch(url, init); };
p = await runTick();
t(p.length === 1 && p[0].body.messages[0].type === "text" && /@Ben Wu 看報表/.test(p[0].body.messages[0].text), "fallback plain " + JSON.stringify(p[0]?.body));
globalThis.fetch = realFetch;
console.log(`${ok} passed, ${bad} failed`);
