// 拆帳喵（第二個 LINE 帳號）：同一個入口用簽章分辨帳號；任何人都能用、只做拆帳、每日上限、跟小幫手不打架
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const blob = v => v instanceof ArrayBuffer ? new Uint8Array(v) : v === undefined ? null : v;
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(blob); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

const BILL = { store: "威仕登", bill_no: "B1", date: "10/20", guests_note: "2+0", cash_total: 10000,
  hostess: [{ name: "小美", mark: "", type: "坐檯", time: "", units: 3, amount: 6000 }], shared: [{ name: "包廂", qty: 1, price: 4000, amount: 4000, cat: "包廂" }], free: [], note: "" };
let isBill = true, billNo = "B1"; const claude = [], calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ url: u, body, auth: init.headers?.authorization || "" });
  if (u.includes("api.anthropic.com")) {
    claude.push(body.model);
    const txt = /判斷這張照片是不是/.test(body.system) ? JSON.stringify({ bill: isBill, bill_no: billNo }) : JSON.stringify({ ...BILL, bill_no: billNo });
    return new Response(JSON.stringify({ content: [{ type: "text", text: txt }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }
  if (u.includes("/content")) return new Response(new Uint8Array([255, 216, 255, 1]), { status: 200, headers: { "content-type": "image/jpeg" } });
  if (u.includes("/summary")) return new Response(JSON.stringify({ groupName: "應酬群" }), { status: 200 });
  return new Response("{}", { status: 200 });
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "tmain", LINE_CHANNEL_SECRET: "smain", MIAO_CHANNEL_TOKEN: "tmiao", MIAO_CHANNEL_SECRET: "smiao", ANTHROPIC_API_KEY: "k", MIAO_DAILY_BILLS: "2" };
const wh = await import(R + "/functions/api/line/miao.js");
const S = await import(R + "/lib/split.js");
const U = await import(R + "/lib/usage.js");
sq.prepare(`INSERT INTO line_kv VALUES('admins','["U_ben"]')`).run();
let n = 0;
const post = async (ev, secret = "smiao") => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls.length = 0; claude.length = 0;
  return wh.onRequestPost({ request: new Request("https://x.dev/api/line/miao", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") } }), env }); };
const replies = () => calls.filter(c => c.url.endsWith("/message/reply"));
const rtext = () => JSON.stringify(replies()[0]?.body.messages || []);
const grp = (G, u, message) => post({ type: "message", source: { type: "group", groupId: G, userId: u }, message });
const photo = (G, u, id) => grp(G, u, { type: "image", id });
const text = (G, u, s, at) => grp(G, u, { type: "text", id: "m" + n, text: (at ? "@拆帳喵 " : "") + s, ...(at ? { mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } : {}) });

// 1. 簽章：兩把都不對就拒絕；拆帳喵的簽章 → 用拆帳喵的鑰匙回
t((await post({ type: "follow", source: { type: "user", userId: "U_x" } }, "nope")).status === 401, "bad signature rejected");
await post({ type: "follow", source: { type: "user", userId: "U_x" } });
t(replies().length === 1 && replies()[0].auth === "Bearer tmiao" && /拆帳喵/.test(rtext()), "follow → miao welcome with miao token");

// 2. 任何人拉進群組都留下，記下「拆帳喵在這裡」
await post({ type: "join", source: { type: "group", groupId: "Cg" } });
t(!calls.some(c => c.url.includes("/leave")) && /嗨，我是拆帳喵/.test(rtext()) && /怎麼用/.test(rtext()), "join stays + welcome");
t(sq.prepare("SELECT v FROM line_kv WHERE k='miao:in:Cg'").get()?.v === "1", "miao:in flag");

// 3. 一般人貼帳單 → 表單卡；記錄是拆帳喵讀的
await photo("Cg", "U_andy", "p1");
t(claude.length === 2 && /喊我|叫我/.test(rtext()) && replies()[0].auth === "Bearer tmiao", "bill → form card " + claude.join());
const sp = sq.prepare("SELECT * FROM line_splits WHERE chat_id='Cg'").get();
t(sp && JSON.parse(sp.data).bot === "miao", "split tagged bot=miao");
// 不是帳單：群組不出聲
isBill = false; await photo("Cg", "U_andy", "p2"); t(!replies().length, "non-bill silent in group"); isBill = true;

// 4. 小幫手在同一個群組：照片交給拆帳喵，小幫手不判斷
await post({ type: "message", source: { type: "group", groupId: "Cg", userId: "U_andy" }, message: { type: "image", id: "p3" } }, "smain");
t(claude.length === 0, "main bot skips bill check where miao is in");

// 5. 每日上限（測試設 2 張）：第三張不讀、只講一次
billNo = "B2"; await photo("Cg", "U_andy", "p4"); t(/喊我|叫我/.test(rtext()), "2nd bill ok");
billNo = "B3"; await photo("Cg", "U_andy", "p5");
t(/明天再來/.test(rtext()) && !claude.some(m => /sonnet/.test(m)), "3rd bill capped, not read");
billNo = "B4"; await photo("Cg", "U_andy", "p6"); t(!replies().length, "cap notice only once a day");
sq.prepare("UPDATE line_splits SET created=? WHERE bill_no='B1'").run(Date.now() - 20 * 60e3);
billNo = "B1"; await photo("Cg", "U_andy", "p7"); t(/喊我|叫我/.test(rtext()) && !claude.some(m => /sonnet/.test(m)), "same bill re-post still answered without re-reading");

// 6. 文字：沒 @ 的閒聊不回；「請款單」「拆帳紀錄」不用 @；@ 了說別的 → 說明
await text("Cg", "U_andy", "今天喝很多"); t(!replies().length, "chatter ignored");
await text("Cg", "U_andy", "拆帳紀錄"); t(/split\?t=/.test(rtext()), "records link without @");
await text("Cg", "U_andy", "請款單"); t(/沒有拆好的帳單/.test(rtext()), "請款單 without @ " + rtext());
await text("Cg", "U_andy", "幫我訂位", true); t(/帳單照片丟給我/.test(rtext()) && !claude.length, "other request → help, no AI");
await text("Cg", "U_andy", "這是香閣的單", true); t(/帳單照片丟給我/.test(rtext()), "non-admin can't set owner");
await text("Cg", "U_ben", "這是香閣的單", true); t(/香閣的單/.test(rtext()), "admin sets owner");
await text("Cg", "U_andy", "關閉拆帳", true); t(/不看這裡的照片/.test(rtext()), "anyone can turn off in their group");
await photo("Cg", "U_andy", "p8"); t(!claude.length, "off → no check");

// 7. 私訊：不是 Ben 也能用
billNo = "D1"; await post({ type: "message", source: { type: "user", userId: "U_stranger" }, message: { type: "image", id: "d1" } });
t(/喊我|叫我/.test(rtext()), "anyone can DM a bill");
isBill = false; await post({ type: "message", source: { type: "user", userId: "U_stranger" }, message: { type: "image", id: "d2" } });
t(/不收|不是我要的|不歸我管/.test(rtext()), "DM non-bill explained"); isBill = true;

// 8. 請款卡 10 分鐘沒人貼：用拆帳喵推播
const d = JSON.parse(sp.data); d.formAt = Date.now() - 20 * 60e3; d.cardAt = null; d.guests = [{ id: "g0", name: "A" }]; d.merge = {};
sq.prepare("UPDATE line_splits SET status='done', done_at=?, data=?, result=? WHERE id=?").run(Date.now() - 15 * 60e3, JSON.stringify(d), JSON.stringify(S.compute(d)), sp.id);
calls.length = 0;
const pushed = await S.pendingCards(env, db, null);
const pc = calls.find(c => c.url.endsWith("/message/push"));
t(pushed === 1 && pc?.auth === "Bearer tmiao" && pc.body.to === "Cg", "pending card pushed with miao token");

// 9. 本月 AI 到 US$80 私訊 Ben 一次（用小幫手）
sq.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,usd) VALUES(?,?,'ai','Cg',81)").run(Date.now(), new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7));
calls.length = 0;
t(await U.checkSpendAlert(env, db), "spend alert fires");
const ap = calls.find(c => c.url.endsWith("/message/push"));
t(ap?.body.to === "U_ben" && ap.auth === "Bearer tmain" && /US\$8/.test(JSON.stringify(ap.body)), "alert DM to Ben via 小幫手");
t(!(await U.checkSpendAlert(env, db)), "alert only once a month");

// 10. 語氣：同一句不會連續出現；請款單用拆帳喵的話，有買單人就加「轉給」
const V = await import(R + "/lib/voice.js");
let prev = "", rep = false;
for (let i = 0; i < 30; i++) { const x = await V.pick(db, "Cv", "ask"); if (x === prev) rep = true; prev = x; }
t(!rep, "no consecutive repeat");
const d2 = JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id=?").get(sp.id).data); d2.payee = "Ben"; d2.cardFix = false;
sq.prepare("UPDATE line_splits SET data=? WHERE id=?").run(JSON.stringify(d2), sp.id);
const cm = await S.cardMessages(db, { ...sq.prepare("SELECT * FROM line_splits WHERE id=?").get(sp.id), d: d2 });
t(/算|好了/.test(cm[0].text) && /Ben/.test(cm[0].text) && !/拆帳完畢/.test(cm[0].text), "miao card head + payee: " + cm[0].text);
t(JSON.stringify(cm[1]).includes("請轉給 Ben"), "card header shows payee");
// 小幫手的單：原本的說法＋請轉給
const cm2 = await S.cardMessages(db, { id: "x", chat_id: "Cz", result: null, d: { ...d2, bot: undefined } });
t(/拆帳完畢/.test(cm2[0].text) && /請轉給 Ben/.test(cm2[0].text), "main card unchanged + payee");
// 表單送出帶買單人
sq.prepare("INSERT INTO line_splits(id,chat_id,created,status,data) VALUES('fp','Cg',?,'ask',?)").run(Date.now(), JSON.stringify({ ...S.normalize(BILL), guests: [], merge: {}, bot: "miao" }));
const fr = await S.finishForm(env, db, null, { chatId: "Cg", id: "fp", body: { payee: " 王董 ", guests: [{ name: "A" }], hostess: { h0: "A" } } });
t(fr.ok && JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id='fp'").get().data).payee === "王董", "form saves payee");

// 11. 偶爾的梗：同一家店本月第三次（3 天內只講一次）
const mk = (id, store, hs) => sq.prepare("INSERT INTO line_splits(id,chat_id,created,status,data) VALUES(?,'Ct',?,'done',?)").run(id, Date.now() - 1000, JSON.stringify({ store, cash: 50000, hostess: hs.map(n => ({ name: n })) }));
mk("t1", "香閣", ["小美"]); mk("t2", "香閣", ["小花"]); mk("t3", "香閣", ["小青"]);
const T = async id => V.tease({ ...env, MIAO_TEASE_GAP_H: "0" }, db, { chatId: "Ct", group: true, split: { id, d: JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id=?").get(id).data) } });
const t3 = await T("t3") || ""; t(/香閣/.test(t3) && (/三/.test(t3) || /專一/.test(t3)), "3rd visit tease " + t3);
t(!/香閣/.test(await T("t3") || ""), "store tease cools down");
mk("t4", "別家", ["小美"]);
t(/小美/.test(await T("t4") || ""), "repeat hostess tease");
t(await T("t4") === null, "nothing else to tease");
mk("t5", "別家2", []); sq.prepare("UPDATE line_splits SET data=? WHERE id='t5'").run(JSON.stringify({ store: "別家2", cash: 200000, hostess: [] }));
t(V.LINES.t_big.includes(await T("t5") || ""), "big bill tease");
// 好酒、很多小姐、坐很久
const mk2 = (id, d) => sq.prepare("INSERT INTO line_splits(id,chat_id,created,status,data) VALUES(?,'Ct',?,'done',?)").run(id, Date.now(), JSON.stringify(d));
mk2("t6", { store: "甲", cash: 50000, hostess: [], shared: [{ name: "麥卡倫 18年", qty: 1, price: 12000, amount: 12000, cat: "酒" }] });
t(/麥卡倫18年/.test(await T("t6") || ""), "fancy bottle tease");
mk2("t7", { store: "乙", cash: 60000, hostess: "ABCDEFGHI".split("").map(n => ({ name: "妹" + n, lines: [] })) });
t(/九位/.test(await T("t7") || ""), "many hostesses tease");
mk2("t8", { store: "丙", cash: 60000, hostess: [{ name: "Z", lines: [{ type: "坐檯", time: "21:0~03:1", units: 1, amount: 400 }] }] });
const lt = await T("t8") || ""; t(/個多小時/.test(lt), "long night tease " + lt);
mk2("t9", { store: "丁", cash: 9000, hostess: [{ name: "Y", lines: [] }] });
t(V.LINES.t_small.includes(await T("t9") || ""), "small bill tease");
// 任何梗之間預設隔 6 小時
t(await V.tease(env, db, { chatId: "Cgap", group: true, split: { id: "zz", d: { cash: 300000, hostess: [] } } }) !== null, "gap: first fires");
t(await V.tease(env, db, { chatId: "Cgap", group: true, split: { id: "zz2", d: { cash: 300000, hostess: [{ name: "x" }], shared: [{ name: "好酒", price: 20000, amount: 20000, cat: "酒" }] } } }) === null, "gap: second within 6h silent");

// 12. 群組裡 @拆帳喵 回覆一張不是帳單的照片說「拆帳」：回一句、不讀帳單
isBill = false;
await grp("Cg2", "U_andy", { type: "text", id: "q1", text: "@拆帳喵 拆帳", quotedMessageId: "img9", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } });
t(/不收|不是我要的|不歸我管/.test(rtext()) && !claude.some(m => /sonnet/.test(m)), "tagged non-bill → short line, no read");
isBill = true;

console.log(`${ok} passed, ${bad} failed`);
