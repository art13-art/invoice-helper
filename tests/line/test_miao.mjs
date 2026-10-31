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
t(!calls.some(c => c.url.includes("/leave")) && /大家好，我是拆帳喵/.test(rtext()), "join stays + welcome");
t(sq.prepare("SELECT v FROM line_kv WHERE k='miao:in:Cg'").get()?.v === "1", "miao:in flag");

// 3. 一般人貼帳單 → 表單卡；記錄是拆帳喵讀的
await photo("Cg", "U_andy", "p1");
t(claude.length === 2 && /拆單服務/.test(rtext()) && replies()[0].auth === "Bearer tmiao", "bill → form card " + claude.join());
const sp = sq.prepare("SELECT * FROM line_splits WHERE chat_id='Cg'").get();
t(sp && JSON.parse(sp.data).bot === "miao", "split tagged bot=miao");
// 不是帳單：群組不出聲
isBill = false; await photo("Cg", "U_andy", "p2"); t(!replies().length, "non-bill silent in group"); isBill = true;

// 4. 小幫手在同一個群組：照片交給拆帳喵，小幫手不判斷
await post({ type: "message", source: { type: "group", groupId: "Cg", userId: "U_andy" }, message: { type: "image", id: "p3" } }, "smain");
t(claude.length === 0, "main bot skips bill check where miao is in");

// 5. 每日上限（測試設 2 張）：第三張不讀、只講一次
billNo = "B2"; await photo("Cg", "U_andy", "p4"); t(/拆單服務/.test(rtext()), "2nd bill ok");
billNo = "B3"; await photo("Cg", "U_andy", "p5");
t(/上限/.test(rtext()) && !claude.some(m => /sonnet/.test(m)), "3rd bill capped, not read");
billNo = "B4"; await photo("Cg", "U_andy", "p6"); t(!replies().length, "cap notice only once a day");
sq.prepare("UPDATE line_splits SET created=? WHERE bill_no='B1'").run(Date.now() - 20 * 60e3);
billNo = "B1"; await photo("Cg", "U_andy", "p7"); t(/拆單服務/.test(rtext()) && !claude.some(m => /sonnet/.test(m)), "same bill re-post still answered without re-reading");

// 6. 文字：沒 @ 的閒聊不回；「請款單」「拆帳紀錄」不用 @；@ 了說別的 → 說明
await text("Cg", "U_andy", "今天喝很多"); t(!replies().length, "chatter ignored");
await text("Cg", "U_andy", "拆帳紀錄"); t(/split\?t=/.test(rtext()), "records link without @");
await text("Cg", "U_andy", "請款單"); t(/沒有拆好的帳單/.test(rtext()), "請款單 without @ " + rtext());
await text("Cg", "U_andy", "幫我訂位", true); t(/我是拆帳喵/.test(rtext()) && !claude.length, "other request → help, no AI");
await text("Cg", "U_andy", "這是香閣的單", true); t(/我是拆帳喵/.test(rtext()), "non-admin can't set owner");
await text("Cg", "U_ben", "這是香閣的單", true); t(/香閣的單/.test(rtext()), "admin sets owner");
await text("Cg", "U_andy", "關閉拆帳", true); t(/不看這裡的照片/.test(rtext()), "anyone can turn off in their group");
await photo("Cg", "U_andy", "p8"); t(!claude.length, "off → no check");

// 7. 私訊：不是 Ben 也能用
billNo = "D1"; await post({ type: "message", source: { type: "user", userId: "U_stranger" }, message: { type: "image", id: "d1" } });
t(/拆單服務/.test(rtext()), "anyone can DM a bill");
isBill = false; await post({ type: "message", source: { type: "user", userId: "U_stranger" }, message: { type: "image", id: "d2" } });
t(/不是有小姐代支/.test(rtext()), "DM non-bill explained"); isBill = true;

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

console.log(`${ok} passed, ${bad} failed`);
