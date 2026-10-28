// 這一批：全形標點、短名、說明卡、承諾偵測、每週回顧、管理員跨群組重點
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
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const ins = (q, ...a) => sq.prepare(q).run(...a);

const calls = []; let haiku = '{"commit":true,"task":"交報價單給王總","due":"2099-01-02T18:00"}', pushFail = false, claudeN = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body ? JSON.parse(init.body) : null; calls.push({ url: u, body });
  if (u.includes("api.anthropic.com")) { claudeN++; return new Response(JSON.stringify({ content: [{ type: "text", text: haiku }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }); }
  if (u.endsWith("/message/push") && pushFail) return new Response("{}", { status: 400 });
  if (u.includes("/group/Cno/member/")) return new Response("{}", { status: 404 });
  if (u.includes("/member/") || u.includes("/profile/")) return new Response(JSON.stringify({ displayName: u.endsWith("U_ben") ? "Ben Wu" : "Amy" }), { status: 200 });
  if (u.includes("/summary")) return new Response(JSON.stringify({ groupName: "96廣告分析" }), { status: 200 });
  return new Response("{}", { status: 200 });
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "k" };
const A = await import(R + "/lib/assistant.js");
const wh = await import(R + "/functions/api/line/webhook.js");
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: Math.random() + "", replyToken: "rt", ...ev }] }); calls.length = 0;
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64") } }), env }); };
const replies = () => calls.filter(c => c.url.endsWith("/message/reply")).map(c => c.body.messages);
const G = "Cg1";
ins("INSERT INTO line_kv VALUES('name:Cg1','96廣告分析')"); ins("INSERT INTO line_kv VALUES('name:Cg2','精油廠商')"); ins(`INSERT INTO line_kv VALUES('admins','["U_ben"]')`);

// 1. 標點與名字
t(A.cleanText("好的,我知道了:明天(週三)交?") === "好的，我知道了：明天（週三）交？", "full width " + A.cleanText("好的,我知道了:明天(週三)交?"));
t(A.cleanText("時間 12:30 金額 3,200 元 https://a.com/x?a=1,2") === "時間 12:30 金額 3,200 元 https://a.com/x?a=1,2", "numbers/urls untouched");
t(A.cleanText("重點:\n- 一") === "重點：\n・一", "newline kept");
t(A.shortName("Ben Wu") === "Ben" && A.shortName("王小明") === "王小明" && A.shortName("Amy") === "Amy", "short names");
const { adminFor } = await import(R + "/lib/escalate.js");
t((await adminFor(env, db, G))?.name === "Ben", "admin called Ben");

// 2. 加入群組、說明 → 卡片
await send({ type: "join", source: { type: "group", groupId: G } });
let m = replies()[0]?.[0];
t(m?.type === "flex" && JSON.stringify(m).includes("大家好，我是小幫手") && JSON.stringify(m).includes("#12524F"), "join card");
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_amy" }, message: { type: "text", id: "1", text: "@小幫手 說明" } });
m = replies()[0]?.[0];
t(m?.type === "flex" && JSON.stringify(m).includes("/總結") && !JSON.stringify(m).includes("拆帳單"), "help card in group (no split item)");
await send({ type: "message", source: { type: "user", userId: "U_ben" }, message: { type: "text", id: "2", text: "說明" } });
t(JSON.stringify(replies()[0]).includes("什麼都能問"), "help card in admin DM");
// 只有 Ben 能用私訊、拉進群
claudeN = 0;
await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "text", id: "2b", text: "幫我寫一封信" } });
t(/私訊不開放/.test(replies()[0]?.[0]?.text) && claudeN === 0, "non-admin DM closed, no AI cost");
await send({ type: "follow", source: { type: "user", userId: "U_amy" } });
t(/私訊不開放/.test(replies()[0]?.[0]?.text), "non-admin follow closed");
await send({ type: "follow", source: { type: "user", userId: "U_ben" } });
t(replies()[0]?.[0]?.type === "flex", "admin follow gets card");
await send({ type: "postback", source: { type: "user", userId: "U_amy" }, postback: { data: "grp:x:Cg1" } });
t(!replies().length, "non-admin DM postback ignored");
await send({ type: "join", source: { type: "group", groupId: "Cno" } });
t(calls.some(c => c.url.endsWith("/group/Cno/leave")) && /先離開/.test(replies()[0]?.[0]?.text), "join without Ben -> leave");
t(!sq.prepare("SELECT 1 FROM line_kv WHERE k='name:Cno'").get(), "no record of refused group");
const src = readFileSync(R + "/lib/assistant.js", "utf8");
t(!/我是小助理/.test(src), "no old name in join notice");

// 3. 承諾偵測：規則
const { looksLikeCommit } = await import(R + "/lib/commit.js");
for (const s of ["我明天交報價單", "週五前我寄給客戶", "我們下週一給你們初稿", "我晚點回覆廠商"]) t(looksLikeCommit(s), "should match: " + s);
for (const s of ["你明天交報價單嗎？", "明天要開會", "我覺得不錯", "誰明天可以交？", "哈哈", "請你明天交給我", "如果我明天交的話會怎樣"]) t(!looksLikeCommit(s), "should not match: " + s);

// 群組裡沒 @ 的一句「我明天交報價單給王總」→ Haiku 確認 → 私訊卡片
claudeN = 0;
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_ben" }, message: { type: "text", id: "3", text: "我明天交報價單給王總" } });
const dm = calls.find(c => c.url.endsWith("/message/push"));
t(claudeN === 1 && dm && dm.body.to === "U_ben" && JSON.stringify(dm.body).includes("要加成待辦嗎") && JSON.stringify(dm.body).includes("96廣告分析"), "DM card sent");
t(!replies().length, "nothing said in group");
const pid = sq.prepare("SELECT id FROM line_pending WHERE kind='commit'").get()?.id;
// 2 小時內同一人不再問
claudeN = 0;
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_ben" }, message: { type: "text", id: "4", text: "我後天寄樣品" } });
t(claudeN === 0, "rate limited");
// 一般訊息不花錢
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_bob" }, message: { type: "text", id: "5", text: "今天天氣不錯" } });
t(claudeN === 0, "no AI for normal chat");
// 別人按不行；本人按「加入待辦」→ 群組待辦＋提醒
await send({ type: "postback", source: { type: "user", userId: "U_bob" }, postback: { data: "cm:yes:" + pid } });
t(/本人/.test(replies()[0]?.[0]?.text), "other person blocked");
await send({ type: "postback", source: { type: "user", userId: "U_ben" }, postback: { data: "cm:yes:" + pid } });
const td = sq.prepare("SELECT * FROM line_todos WHERE chat_id=?").get(G);
t(td && td.task === "交報價單給王總" && td.assignee_id === "U_ben" && td.due, "todo created in group");
t(sq.prepare("SELECT count(*) n FROM line_reminders WHERE todo_id=?").get(td.id).n === 2, "eve + due reminders");
t(/已加到「96廣告分析」/.test(replies()[0]?.[0]?.text), "confirm text " + replies()[0]?.[0]?.text);
await send({ type: "postback", source: { type: "user", userId: "U_ben" }, postback: { data: "cm:yes:" + pid } });
t(/已經加過/.test(replies()[0]?.[0]?.text), "double press");
// 不是管理員（私訊不開放）→ 在群組回覆那句、@本人，不推播
pushFail = false;
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_cat" }, message: { type: "text", id: "6", text: "我週五前寄合約給客戶" } });
const gr = replies()[0];
t(gr && gr[0].type === "textV2" && gr[0].substitution.m0.mentionee.userId === "U_cat" && gr[1].type === "flex", "group fallback with mention");
t(!calls.some(c => c.url.endsWith("/message/push")), "no DM push to non-admin");
pushFail = false;
// Haiku 說不是承諾 → 什麼都不做
haiku = '{"commit":false}';
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_dan" }, message: { type: "text", id: "7", text: "我們明天再處理好了啦哈哈" } });
t(!calls.some(c => c.url.endsWith("/message/push")) && !replies().length, "not a commitment → silent");
// 廠商群組不問
ins(`INSERT INTO line_kv VALUES('flows','[{"id":"f1","notify":"Cg2"}]')`);
haiku = '{"commit":true,"task":"寄貨","due":"2099-01-02T18:00"}'; claudeN = 0;
await send({ type: "message", source: { type: "group", groupId: "Cg2", userId: "U_eve" }, message: { type: "text", id: "8", text: "我明天寄貨" } });
t(claudeN === 0, "vendor group skipped");

// 4. 每週回顧／管理員跨群組重點
const now = Date.now();
ins("INSERT INTO line_digests VALUES(?,?,?,?)", G, A.ymd(now - 3 * 864e5), "・決定改用 B 版素材", now);
ins("INSERT INTO line_msgs(chat_id,user_id,name,text,ts) VALUES(?,?,?,?,?)", G, "U_amy", "Amy", "今天 CTR 2.1%", now - 3600e3);
ins("INSERT INTO line_msgs(chat_id,user_id,name,text,ts) VALUES(?,?,?,?,?)", "Cg2", "U_eve", "Eve", "貨明天到", now - 7200e3);
sq.prepare("UPDATE line_todos SET status='done', done_at=? WHERE id=?").run(now - 864e5, td.id);
ins("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES('zz99',?,?,NULL,'Amy',?,'open',?,NULL)", G, "交月報", now - 864e5, now - 5 * 864e5);
const ctx = { env, db, chatId: G, userId: "U_amy", userName: "Amy", isAdmin: false };
const w = await A.runTool(ctx, "week_review", {});
t(w.每日重點.length === 1 && /B 版/.test(w.每日重點[0]), "week digests");
t(w.完成的待辦.some(x => x.includes("交報價單給王總")), "week done todos");
t(w.未完成的待辦.some(x => x.includes("交月報") && x.includes("已逾期")), "week overdue");
t(/CTR 2.1%/.test(w.最近還沒整理的訊息), "recent raw included");
t(/error/.test(JSON.stringify(await A.runTool(ctx, "all_groups_digest", {}))), "non-admin blocked from all groups");
const ag = await A.runTool({ ...ctx, chatId: "U_ben", userId: "U_ben", isAdmin: true }, "all_groups_digest", {});
t(ag.群組.length === 2 && ag.群組.some(g => g.群組 === "精油廠商" && /貨明天到/.test(g.對話)), "admin sees all groups");
t(ag.群組.find(g => g.群組 === "96廣告分析").待辦.some(x => x.includes("已逾期")), "admin sees overdue");
const ag7 = await A.runTool({ ...ctx, isAdmin: true }, "all_groups_digest", { hours: 168 });
t(/B 版/.test(ag7.群組.find(g => g.群組 === "96廣告分析").對話), "week uses digests");

// 5. 提示詞規則都在
for (const s of ["每一件都要回到", "假設", "每一點附來源", "最多 3 行", "不說教", "只叫名", "標點一律用全形", "不要 ask_admin", "Claude Sonnet 5.5"]) t(src.includes(s), "prompt rule: " + s);
console.log(`${ok} passed, ${bad} failed`);
