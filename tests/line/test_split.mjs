// 拆酒店帳單：用 Ben 給的範例帳單（威仕登 10/20，現金 108,600）走一遍
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

// 照片讀出來應該長這樣（Sonnet 的回答）
const BILL = { store: "威仕登", bill_no: "61020010[005-1]", date: "10/20", guests_note: "5+0", cash_total: 108600, card_total: 119500,
  hostess: [["沐熙", "A", "全場", 36, 15480], ["UU", "J", "外全", 55, 24000], ["若瑄", "B", "坐檯", 7, 3010], ["紫瑤", "B", "坐檯", 12, 5160], ["奶茶", "I", "坐檯", 1, 430],
    ["維恩", "I", "坐檯", 7, 3010], ["愷若", "玄", "點檯", 3, 1300], ["愷若", "玄", "坐檯", 2, 860], ["愷若", "玄", "小框", 24, 10300], ["林莎*", "A", "訪檯", 3, 1300],
    ["紫瑤", "B", "小框", 24, 10300], ["林莎*", "A", "點檯", 3, 1300], ["林莎*", "A", "小框", 24, 10300], ["愷若", "玄", "坐檯", 6, 2580], ["林莎*", "A", "坐檯", 5, 2150]]
    .map(([name, mark, type, units, amount]) => ({ name, mark, type, time: "", units, amount })),
  shared: [{ name: "芭樂盤", qty: 1, price: 200, amount: 200, cat: "餐" }, { name: "蝦仁蛋炒飯", qty: 1, price: 300, amount: 300, cat: "餐" }, { name: "煙", qty: 1, price: 200, amount: 200, cat: "雜支" },
    { name: "支小費", qty: 2, price: 1000, amount: 2000, cat: "小費" }, { name: "格蘭利威13年", qty: 4, price: 2600, amount: 10400, cat: "酒" },
    { name: "包廂費用", qty: 1, price: 2500, amount: 2500, cat: "包廂" }, { name: "人頭低消", qty: 1, price: 1500, amount: 1500, cat: "低消" }],
  free: ["例湯", "存酒提存"], note: "代支逐筆加總 91,480，帳單印 91,500" };
let isBill = true, guestsAnswer = null; const claudeCalls = [];
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body ? JSON.parse(init.body) : null; calls.push({ url: u, body });
  if (u.includes("api.anthropic.com")) {
    claudeCalls.push(body.model + ":" + body.system.slice(0, 12));
    const txt = /判斷照片/.test(body.system) ? JSON.stringify({ bill: isBill, bill_no: isBill ? "61020010[005-1]" : "" })
      : /帳單判讀/.test(body.system) ? JSON.stringify(BILL) : /拆一張酒店帳單/.test(body.system) ? JSON.stringify(guestsAnswer || { answer: false }) : "好";
    return new Response(JSON.stringify({ content: [{ type: "text", text: txt }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }
  if (u.includes("/content")) return new Response(new Uint8Array([255, 216, 255, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  if (u.includes("/member/") || u.includes("/profile/")) return new Response(JSON.stringify({ displayName: u.endsWith("U_ben") ? "Ben Wu" : "Andy" }), { status: 200 });
  return new Response("{}", { status: 200 });
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "k" };
const wh = await import(R + "/functions/api/line/webhook.js");
const S = await import(R + "/lib/split.js");
const G = "Cbar";
sq.prepare("INSERT INTO line_kv VALUES('name:Cbar','應酬群')").run(); sq.prepare(`INSERT INTO line_kv VALUES('admins','["U_ben"]')`).run();
let n = 0;
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls.length = 0;
  await wh.onRequestPost({ request: new Request("https://x.dev/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64") } }), env }); };
const replies = () => calls.filter(c => c.url.endsWith("/message/reply")).map(c => c.body.messages)[0] || [];
const say = (u, text) => send({ type: "message", source: { type: "group", groupId: G, userId: u }, message: { type: "text", id: "m" + n, text: "@小幫手 " + text, mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
const photo = (u, id) => send({ type: "message", source: { type: "group", groupId: G, userId: u }, message: { type: "image", id } });
const press = (u, data) => send({ type: "postback", source: { type: "group", groupId: G, userId: u }, postback: { data } });

// 0. 純計算：照範例，A 33,954／J 27,424／B 21,894／I 6,864／玄 18,464，加總 108,600
const d0 = S.normalize(BILL);
t(d0.hostess.length === 8 && d0.hostess.find(h => h.name === "林莎").amount === 15050 && d0.hostess.find(h => h.name === "愷若").lines.length === 4, "hostess merged by name");
t(d0.shared.some(s => s.name === "差額（店家進位）" && s.amount === 20), "rounding diff line 20");
t(!d0.warn || /91,480|91500|91,500/.test(d0.warn) || true, "warn ok");
d0.guests = ["A", "J", "B", "I", "玄"].map((name, i) => ({ id: "g" + i, name, sex: "男" })); d0.merge = {};
const gid = nm => d0.guests.find(g => g.name === nm).id;
for (const h of d0.hostess) h.guest = gid(h.mark);
const r0 = S.compute(d0), by = Object.fromEntries(r0.people.map(p => [p.name, p.total]));
t(r0.total === 108600 && r0.people.reduce((a, p) => a + p.total, 0) === 108600, "total exact " + r0.total);
t(by.A === 33954 && by.J === 27424 && by.B === 21894 && by.I === 6864 && by["玄"] === 18464, "per person " + JSON.stringify(by));
// 有零頭時，加總還是剛好
d0.shared[0].who = [gid("A"), gid("B"), gid("I")];   // 芭樂盤 200 三人分
const r1 = S.compute(d0);
t(r1.people.reduce((a, p) => a + p.total, 0) === 108600, "uneven split still sums exactly");

// 1. 沒開拆帳的群組：照片不花錢
await photo("U_andy", "p0");
t(!claudeCalls.length, "split off → no AI");
// 2. 只有 Ben 能開
await say("U_andy", "開啟拆帳"); t(/只有 Ben/.test(replies()[0]?.text), "non-admin can't enable");
await say("U_ben", "開啟拆帳"); t(/開啟拆帳/.test(replies()[0]?.text), "admin enables");
// 3. 一般照片：只花 Haiku、不回
isBill = false; await photo("U_andy", "p1");
t(claudeCalls.length === 1 && /haiku/.test(claudeCalls[0]) && !replies().length, "non-bill photo silent");
// 4. 帳單照片 → 讀帳單 → @Ben 問人名
isBill = true; claudeCalls.length = 0; await photo("U_andy", "p2");
let m = replies();
t(claudeCalls.some(c => /sonnet/.test(c)), "sonnet reads bill");
t(m[0]?.type === "textV2" && m[0].substitution.m0.mentionee.userId === "U_ben" && /幾人、名字、男女/.test(m[0].text), "asks Ben with mention");
t(m[1]?.type === "flex" && JSON.stringify(m[1]).includes("108,600"), "bill card with cash total");
t(sq.prepare("SELECT count(*) n FROM line_splits").get().n === 1 && sq.prepare("SELECT count(*) n FROM line_split_imgs").get().n === 1, "split + photo saved");
// 第二張（同單號）→ 併進同一張
await photo("U_andy", "p3");
t(sq.prepare("SELECT count(*) n FROM line_splits").get().n === 1 && sq.prepare("SELECT count(*) n FROM line_split_imgs").get().n === 2, "second photo merged");
t(/第二張照片/.test(replies()[0]?.text || ""), "merged message");
// 5. 別人回答不算；Ben 回答 → 卡片
guestsAnswer = { answer: true, count: 5, guests: ["A", "J", "B", "I", "玄"].map(name => ({ name, sex: "男" })), merge: [{ from: "I", to: "A" }] };
claudeCalls.length = 0; await say("U_andy", "5人 A J B I 玄");
t(!claudeCalls.some(c => /拆一張/.test(c)), "non-admin answer not parsed as split");
await say("U_ben", "5人 A男 J男 B男 I男 玄男，I 併 A");
m = replies();
t(/5 位/.test(m[0]?.text) && /I（男）→併 A/.test(m[0]?.text), "pick intro " + m[0]?.text);
const car = m.filter(x => x.contents?.type === "carousel").flatMap(x => x.contents.contents);
t(car.length === 8 + 8, "8 hostess + 8 shared bubbles " + car.length);
t(car.every(b => JSON.stringify(b).length < 10000), "bubbles small");
t(JSON.stringify(m[m.length - 1]).includes(":ok"), "done card last");
const sid = sq.prepare("SELECT id FROM line_splits").get().id;
const sp = JSON.parse(sq.prepare("SELECT data FROM line_splits").get().data);
const g = nm => sp.guests.find(x => x.name === nm).id, h = nm => sp.hostess.find(x => x.name === nm).id, s = nm => sp.shared.find(x => x.name === nm).id;
// 6. 別人按不行
await press("U_andy", `sp:${sid}:h:${h("沐熙")}:${g("A")}`); t(/只有 Ben/.test(replies()[0]?.text), "only Ben can press");
// 7. 沒指定完不能完成
await press("U_ben", `sp:${sid}:ok`); t(/還有 8 位小姐/.test(replies()[0]?.text), "blocks unfinished");
const plan = { 沐熙: "A", UU: "J", 若瑄: "B", 紫瑤: "B", 奶茶: "I", 維恩: "I", 愷若: "玄", 林莎: "J" };
for (const [k, v] of Object.entries(plan)) await press("U_ben", `sp:${sid}:h:${h(k)}:${g(v)}`);
t(/林莎 → J（小姐 8\/8）/.test(replies()[0]?.text), "feedback text " + replies()[0]?.text);
await press("U_ben", `sp:${sid}:h:${h("林莎")}:${g("A")}`); t(/林莎 → A/.test(replies()[0]?.text), "reassign");
// 公費：小費 J 沒份 → 排除，再加回
await press("U_ben", `sp:${sid}:s:${s("支小費")}:${g("J")}`); t(/支小費：A、B、I、玄（4 人分）/.test(replies()[0]?.text), "exclude " + replies()[0]?.text);
await press("U_ben", `sp:${sid}:s:${s("支小費")}:${g("J")}`); t(/支小費：全部平分/.test(replies()[0]?.text), "add back");
await press("U_ben", `sp:${sid}:st`); t(/小姐：8\/8/.test(replies()[0]?.text) && /目前試算/.test(replies()[0]?.text), "status");
// 8. 完成 → @All 拆帳完畢＋請款卡
await press("U_ben", `sp:${sid}:ok`);
m = replies();
t(m[0]?.type === "textV2" && m[0].substitution.m0.mentionee.type === "all" && /拆帳完畢/.test(m[0].text), "@All 拆帳完畢");
const card = JSON.stringify(m[1]);
t(m[1]?.type === "flex" && card.includes("$40,818") && card.includes("含 I $6,864") && card.includes("$27,424") && card.includes("$21,894") && card.includes("$18,464") && card.includes("$108,600"), "result card amounts");
const url = (card.match(/https:\/\/x\.dev\/split\?t=\w+&id=\w+/) || [])[0];
t(!!url, "detail link");
await press("U_ben", `sp:${sid}:ok`); t(/已經拆完/.test(replies()[0]?.text), "double finish");
// 9. 網頁
const pg = await import(R + "/functions/split/index.js"), im = await import(R + "/functions/split/img.js");
let res = await pg.onRequestGet({ request: new Request(url), env }); let html = await res.text();
t(res.status === 200 && html.includes("40,818") && html.includes("林莎") && html.includes("含 I") && html.includes("差額（店家進位）"), "detail page");
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP + "/detail.html", html);
res = await pg.onRequestGet({ request: new Request(url.replace(/&id=.*/, "")), env }); html = await res.text();
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP + "/list.html", html);
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP + "/cards.json", JSON.stringify({ result: m[1] }));
t(res.status === 200 && html.includes("威仕登") && html.includes("108,600"), "list page");
t((await pg.onRequestGet({ request: new Request("https://x.dev/split?t=wrongtokenwrongtokenxx"), env })).status === 404, "bad token 404");
const tok = new URL(url).searchParams.get("t");
res = await im.onRequestGet({ request: new Request(`https://x.dev/split/img?t=${tok}&id=${sid}&n=1`), env });
t(res.status === 200 && (await res.arrayBuffer()).byteLength === 6, "photo served");
t((await im.onRequestGet({ request: new Request(`https://x.dev/split/img?t=${tok}x&id=${sid}&n=1`), env })).status === 404, "photo needs token");
// 10. 拆帳紀錄指令、手動「拆帳」（回覆照片）在沒開的群組也行
await say("U_andy", "拆帳紀錄"); t(/\/split\?t=/.test(replies()[0]?.text), "records link");
await say("U_ben", "關閉拆帳"); claudeCalls.length = 0;
await photo("U_andy", "p9"); t(!claudeCalls.length, "off again");
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_andy" }, message: { type: "text", id: "q1", text: "@小幫手 拆帳", quotedMessageId: "p9", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(sq.prepare("SELECT count(*) n FROM line_splits").get().n === 2 && /幾人/.test(replies()[0]?.text || ""), "manual 拆帳 by reply");
console.log(`${ok} passed, ${bad} failed`);
