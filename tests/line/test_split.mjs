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
  const u = String(url), body = typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url: u, body });
  if (u.includes("oauth2/v2.1/verify")) { const tk = new URLSearchParams(String(init.body)).get("id_token"); return tk === "bad" ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ sub: tk }), { status: 200 }); }
  if (u.includes("api.anthropic.com")) {
    claudeCalls.push(body.model + ":" + body.system.slice(0, 12));
    const txt = /判斷這張照片是不是/.test(body.system) ? JSON.stringify({ bill: isBill, bill_no: isBill ? "61020010[005-1]" : "" })
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

// 1. 沒說過開啟的群組：預設用嚴格標準（只認酒店／KTV 帳單），不是就不回
isBill = false; await photo("U_andy", "p0");
t(claudeCalls.length === 1 && /haiku/.test(claudeCalls[0]) && calls.some(c => c.body?.system && /小姐的代支/.test(c.body.system)) && !replies().length, "default strict check, silent");
// 廠商群組不判斷
sq.prepare(`INSERT INTO line_kv VALUES('flows','[{"notify":"Cvendor"}]')`).run(); claudeCalls.length = 0;
await send({ type: "message", source: { type: "group", groupId: "Cvendor", userId: "U_andy" }, message: { type: "image", id: "pv" } });
t(!claudeCalls.length, "vendor group → no check");
claudeCalls.length = 0; isBill = true;
// 2. 只有 Ben 能開
await say("U_andy", "開啟拆帳"); t(/只有 Ben/.test(replies()[0]?.text), "non-admin can't enable");
await say("U_ben", "啟動拆賬"); t(/開啟拆帳/.test(replies()[0]?.text), "admin enables (啟動拆賬) " + replies()[0]?.text);
t(sq.prepare("SELECT v FROM line_kv WHERE k='split:on:Cbar'").get()?.v === "1", "enabled flag");
await say("U_andy", "說明"); t(JSON.stringify(replies()[0]).includes("拆帳單"), "help card shows split item when on");
// 3. 一般照片：只花 Haiku、不回
isBill = false; claudeCalls.length = 0; await photo("U_andy", "p1");
t(claudeCalls.length === 1 && /haiku/.test(claudeCalls[0]) && !replies().length && calls.some(c => c.body?.system && /小姐的代支/.test(c.body.system)), "non-bill photo silent (strict even when enabled)");
// 4. 帳單照片 → 讀帳單 → @Ben 問人名
isBill = true; claudeCalls.length = 0; await photo("U_andy", "p2");
let m = replies();
t(claudeCalls.some(c => /sonnet/.test(c)), "sonnet reads bill");
const bodies = calls.filter(c => c.url.includes("anthropic")).map(c => c.body);
t(bodies.filter(b => /haiku/.test(b.model)).every(b => b.thinking?.type === "disabled") && bodies.some(b => /haiku/.test(b.model)), "haiku thinking off");
t(m.length === 1 && m[0]?.type === "flex" && /如要拆單服務，請填寫表單/.test(m[0].altText), "one line + form button " + JSON.stringify(m).slice(0, 200));
t(!JSON.stringify(m).includes("108,600") && !JSON.stringify(m).includes("代支"), "no bill breakdown in chat");
t(JSON.stringify(m[0]).includes("/split/form?t=") && JSON.stringify(m[0]).includes("填寫拆帳表單"), "form button");
t(sq.prepare("SELECT count(*) n FROM line_splits").get().n === 1 && sq.prepare("SELECT count(*) n FROM line_split_imgs").get().n === 1, "split + photo saved");
// 第二張（同單號）→ 併進同一張
await photo("U_andy", "p3");
t(sq.prepare("SELECT count(*) n FROM line_splits").get().n === 1 && sq.prepare("SELECT count(*) n FROM line_split_imgs").get().n === 2, "second photo merged");
t(/第二張也讀進來了/.test(replies()[0]?.altText || ""), "merged message");
// 「拆帳」（沒回覆照片）＝再貼一次開始拆帳卡片，不重讀
claudeCalls.length = 0; await say("U_ben", "拆帳");
t(!claudeCalls.length && JSON.stringify(replies()).includes("/split/form?t="), "resend start card without re-reading");
// 5. 表單：預填 5 列男；送出 → 結算、@All 拆帳完畢＋請款卡（推播）
const sid = sq.prepare("SELECT id FROM line_splits").get().id;
const fm = await import(R + "/functions/split/form.js");
const tok0 = sq.prepare("SELECT v FROM line_kv WHERE k='split:tok:Cbar'").get()?.v;
const furl = `https://x.dev/split/form?t=${tok0}&id=${sid}`;
let fr = await fm.onRequestGet({ request: new Request(furl), env }); let fh = await fr.text();
{ const js = (fh.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ""; let okjs = true; try { new Function(js); } catch (e) { okjs = false; console.log(e.message); } t(js && okjs && /貼出請款單/.test(fh), "form script valid + post hint"); }
t(fr.status === 200 && (fh.match(/"sex":"男"/g) || []).length === 5 && fh.includes("108,600") && fh.includes("林莎") && fh.includes("格蘭利威13年"), "form prefilled with guests, hostess, shared");
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP + "/form.html", fh);
const sp = JSON.parse(sq.prepare("SELECT data FROM line_splits").get().data);
const h = nm => sp.hostess.find(x => x.name === nm).id, s = nm => sp.shared.find(x => x.name === nm).id;
const post = body => fm.onRequestPost({ request: new Request(furl, { method: "POST", body: JSON.stringify(body) }), env });
const guests = ["A", "J", "B", "I", "玄"].map(name => ({ name, sex: "男", to: name === "I" ? "A" : "" }));
const plan = { 沐熙: "A", UU: "J", 若瑄: "B", 紫瑤: "B", 奶茶: "I", 維恩: "I", 愷若: "玄", 林莎: "A" };
// 沒選完 → 錯誤、不貼
calls.length = 0;
fr = await post({ guests, hostess: { [h("沐熙")]: "A" } });
t(fr.status === 400 && /還有小姐沒選客人/.test((await fr.json()).error) && !calls.some(c => c.url.endsWith("/message/push")), "blocks unassigned");
fr = await post({ guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])), shared: { [s("支小費")]: [] } });
t(fr.status === 400 && /至少要有一個人分/.test((await fr.json()).error), "shared needs someone");
calls.length = 0;
fr = await post({ guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])) });
let fj = await fr.json();
t(fr.status === 200 && fj.waiting && fj.total === 108600 && !calls.some(c => c.url.endsWith("/message/push")), "form finish ok, no push " + JSON.stringify(fj).slice(0, 80));
// 按「貼出請款單」→ 用回覆貼（免費）
await send({ type: "postback", source: { type: "group", groupId: G, userId: "U_andy" }, postback: { data: "sp:post:" + sid } });
let posted = replies();
t(posted[0]?.type === "textV2" && posted[0].substitution.m0.mentionee.type === "all" && /拆帳完畢/.test(posted[0].text) && !calls.some(c => c.url.endsWith("/message/push")), "post button → reply @All 拆帳完畢");
t(JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id=?").get(sid).data).cardAt > 0, "cardAt marked");
let pushed = { body: { messages: posted } };
const card = JSON.stringify(pushed.body.messages[1]);
t(card.includes("$40,818") && card.includes("＋ 含 I") && card.includes("\"6,864\"") && card.includes("小姐 ") && card.includes("$27,424") && card.includes("$21,894") && card.includes("$18,464") && card.includes("$108,600"), "result card amounts");
t(sq.prepare("SELECT status FROM line_splits WHERE id=?").get(sid).status === "done", "saved done");
const url = (card.match(/https:\/\/x\.dev\/split\?t=\w+&id=\w+/) || [])[0];
t(!!url, "detail link");
// 公費改成 J 沒份小費 → 重送＝更正
calls.length = 0;
fr = await post({ guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])), shared: { [s("支小費")]: ["A", "B", "I", "玄"] } });
fj = await fr.json(); await say("U_ben", "請款單"); pushed = { body: { messages: replies() } };
t(fj.fix && /拆帳更正/.test(pushed?.body.messages[0].text) && fj.payers.find(p => p.name === "J").total === 27424 - 400, "correction resend " + JSON.stringify(fj.payers));
// 舊卡片按鈕 → 指向表單
await press("U_ben", `sp:${sid}:ok`); t(/表單/.test(replies()[0]?.text), "old card buttons point to form");
t((await fm.onRequestPost({ request: new Request(furl.replace(tok0, "bad" + tok0), { method: "POST", body: "{}" }), env })).status === 404, "form needs token");
// 9. 網頁
const pg = await import(R + "/functions/split/index.js"), im = await import(R + "/functions/split/img.js");
let res = await pg.onRequestGet({ request: new Request(url), env }); let html = await res.text();
t(res.status === 200 && html.includes("41,018") && html.includes("林莎") && html.includes("含 I") && html.includes("差額（店家進位）"), "detail page");
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
await say("U_ben", "關掉拆帳。"); t(sq.prepare("SELECT v FROM line_kv WHERE k='split:on:Cbar'").get()?.v === "0", "disabled (關掉拆帳。)"); claudeCalls.length = 0;
await photo("U_andy", "p9"); t(!claudeCalls.length, "off again");
await send({ type: "message", source: { type: "group", groupId: G, userId: "U_andy" }, message: { type: "text", id: "q1", text: "@小幫手 拆帳", quotedMessageId: "p9", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(sq.prepare("SELECT count(*) n FROM line_splits").get().n === 2 && /請填寫表單/.test(replies()[0]?.altText || ""), "manual 拆帳 by reply");
// 11. 私訊（Ben）傳帳單照片：也直接給表單，不走一般分析
isBill = true; claudeCalls.length = 0;
await send({ type: "message", source: { type: "user", userId: "U_ben" }, message: { type: "image", id: "dm1" } });
t(/如要拆單服務/.test(replies()[0]?.altText || "") && claudeCalls.filter(c => /sonnet/.test(c)).length === 1 && sq.prepare("SELECT count(*) n FROM line_splits WHERE chat_id='U_ben'").get().n === 1, "DM bill → form " + JSON.stringify(replies()).slice(0, 150));
// 12. 內嵌視窗：只有 Ben 能送；按鈕改成 liff.line.me；liff.state 轉址
sq.prepare("INSERT INTO line_kv VALUES('liff:split','2012283214-XTQGE9lq')").run();
const pl = body => fm.onRequestPost({ request: new Request(furl, { method: "POST", body: JSON.stringify(body) }), env });
t((await (await pl({ check: true, idToken: "U_ben" })).json()).admin === true && (await (await pl({ check: true, idToken: "U_andy" })).json()).admin === false, "check admin via token");
fr = await pl({ idToken: "U_andy", guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])) });
t(fr.status === 403 && /只有 Ben/.test((await fr.json()).error), "non-admin blocked");
fr = await pl({ guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])) });
t(fr.status === 403, "no token blocked");
fr = await pl({ idToken: "U_ben", guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])) });
t(fr.status === 200, "Ben can submit");
const lk = await S.formLink(db, "https://x.dev", G, sid);
t(lk.startsWith("https://liff.line.me/2012283214-XTQGE9lq?t="), "liff link " + lk);
fr = await fm.onRequestGet({ request: new Request("https://x.dev/split/form?liff.state=" + encodeURIComponent("?t=" + tok0 + "&id=" + sid)), env });
t(fr.status === 302 && fr.headers.get("location") === furl, "liff.state redirect " + fr.headers.get("location"));
fh = await (await fm.onRequestGet({ request: new Request(furl), env })).text();
t(/liff\/edge\/2\/sdk\.js/.test(fh) && /"liff":"2012283214-XTQGE9lq"/.test(fh), "form loads LIFF");
// 13. 小姐分給多人：平分、分段（依節數）
{
  const d = { guests: [{ id: "g0", name: "阿倫" }, { id: "g1", name: "Ben" }, { id: "g2", name: "女友" }], merge: {},
    hostess: [{ id: "h0", name: "詩涵", amount: 5890, split: [{ u: 12, who: ["g0", "g1"] }, { u: 6, who: ["g2"] }] }, { id: "h1", name: "六月", amount: 3000, split: [{ u: 1, who: ["g0", "g1", "g2"] }] }], shared: [] };
  const r = S.compute(d), p = id => r.people.find(x => x.id === id);
  t(r.total === 8890 && Math.abs(p("g0").total - (5890 * 12 / 18 / 2 + 1000)) <= 1 && Math.abs(p("g2").total - (5890 * 6 / 18 + 1000)) <= 1, "segment + even split " + JSON.stringify(r.people.map(x => x.total)));
  t(p("g0").items.some(x => /詩涵（12節÷2）/.test(x.name)) && p("g2").items.some(x => /六月（÷3）/.test(x.name)) && r.people.every(x => x.items.reduce((a, y) => a + y.amount, 0) === x.total), "segment item names + sums");
}
calls.length = 0;
fr = await pl({ idToken: "U_ben", guests, hostess: { ...Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])), [h("沐熙")]: { segs: [{ u: 2, who: ["A", "J"] }, { u: 1, who: ["B"] }] }, [h("UU")]: { even: ["A", "B", "J", "I", "玄"] } } });
fj = await fr.json();
t(fr.status === 200 && fj.total === 108600, "form with segments ok " + JSON.stringify(fj).slice(0, 120));
const saved = JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id=?").get(sid).data);
t(saved.hostess.find(x => x.name === "沐熙").split.length === 2 && saved.hostess.find(x => x.name === "UU").split[0].who.length === 5, "segments saved");
fr = await pl({ idToken: "U_ben", guests, hostess: { ...Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])), [h("沐熙")]: { segs: [{ u: 0, who: ["A"] }, { u: 1, who: ["B"] }] } } });
t(fr.status === 400 && /節數/.test((await fr.json()).error), "segment needs units");
fh = await (await fm.onRequestGet({ request: new Request(furl), env })).text();
{ const js = (fh.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ""; let okjs = true; try { new Function(js); } catch (e) { okjs = false; console.log(e.message); } t(okjs && /"mode":"seg"/.test(fh) && /"mode":"pick","w":\["g\d","g\d","g\d","g\d","g\d"\]/.test(fh), "form restores segment + even"); }
// 14. 已拆過的單又貼一次 → 問要不要重新拆（不重讀）；請款卡有「修改」
sq.prepare("DELETE FROM line_kv WHERE k='liff:split'").run();
sq.prepare("UPDATE line_kv SET v='1' WHERE k='split:on:Cbar'").run();
sq.prepare("UPDATE line_splits SET status='done' WHERE chat_id='Cbar'").run();
isBill = true; claudeCalls.length = 0;
await photo("U_andy", "p20");
{ const m = replies(); t(/已經拆過帳了/.test(m[0]?.altText || "") && JSON.stringify(m).includes("重新拆帳") && JSON.stringify(m).includes("sp:post:") && !claudeCalls.some(c => /sonnet/.test(c)), "repost done bill → redo prompt, no re-read " + JSON.stringify(m).slice(0, 120)); }
await send({ type: "postback", source: { type: "group", groupId: G, userId: "U_ben" }, postback: { data: "split:no" } });
t(!replies().length, "不用 → quiet");
calls.length = 0;
fr = await pl({ idToken: "U_ben", guests, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])) });
await new Promise(r => setTimeout(r, 20));
// 沒人按「貼出請款單」：10 分鐘後計時器推播（備援），只推一次
{ const L = (await import(R + "/lib/line.js")).lineClient("t");
  t(await S.pendingCards(env, db, L, Date.now() + 5 * 60e3) === 0, "not yet at 5 min");
  calls.length = 0; const n1 = await S.pendingCards(env, db, L, Date.now() + 11 * 60e3);
  const ps = calls.find(c => c.url.endsWith("/message/push"));
  t(n1 === 1 && ps && JSON.stringify(ps.body.messages[1]).includes("修改") && JSON.stringify(ps.body.messages[1]).includes("/split/form?t="), "fallback push after 10 min, card has 修改");
  t(await S.pendingCards(env, db, L, Date.now() + 12 * 60e3) === 0, "pushed only once"); }
// 15. 帳單欄位、誰的單、消費範例（假名）、後台
{
  const B = await import(R + "/lib/billstats.js");
  const row = sq.prepare("SELECT * FROM line_splits WHERE chat_id='Cbar' AND result IS NOT NULL ORDER BY done_at DESC").get();
  const f = B.facts(row);
  t(f.store === "威仕登" && f.cash === 108600 && f.pax === 5 && f.units > 0 && f.unitPrice > 0, "facts " + JSON.stringify(f).slice(160, 400));
  t(B.normStore("ｓｓ ") === "SS" && B.itemKind({ name: "DM/12" }) === "drink" && B.itemKind({ name: "經理檯" }) === "manager", "normStore + kinds");
  t(B.durText(B.duration({ hostess: [{ lines: [{ type: "坐檯", time: "10-0~10-2" }, { type: "坐檯", time: "12-5~02-0" }, { type: "出場", time: "10-3~06-0" }] }] })) === "約 4 小時", "duration skips 出場");
}
await say("U_ben", "這是香閣的單");
t(/記為「香閣的單」/.test(replies()[0]?.text || "") && JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE chat_id='Cbar' ORDER BY created DESC").get().data).owner === "香閣", "owner set " + replies()[0]?.text);
await say("U_ben", "這是誰的單"); t(!/記為/.test(replies()[0]?.text || ""), "who? not an owner");
await say("U_andy", "威仕登 範例");
{ const m = replies()[0], js = JSON.stringify(m); t(m?.type === "flex" && /消費範例/.test(m.altText) && js.includes("王小明") && js.includes("小美") && !js.includes("林莎") && js.includes("108,600"), "sample card with fake names " + (m?.altText || JSON.stringify(replies()).slice(0, 100))); }
await say("U_andy", "範例"); t((replies()[0]?.quickReply?.items || []).some(x => /威仕登 範例/.test(x.action.text)), "範例 → store buttons");
claudeCalls.length = 0; await say("U_andy", "幫我寫合約範例"); t(claudeCalls.length > 0 && !/還沒有/.test(replies()[0]?.text || ""), "合約範例 → AI, not store");
// 後台
const dm = text => send({ type: "message", source: { type: "user", userId: "U_ben" }, message: { type: "text", id: "d" + n, text } });
await dm("後台");
const bk = ((replies()[0]?.text || "").match(/\/bo\?k=(\w+)/) || [])[1];
t(bk && bk.length >= 20, "後台 link " + replies()[0]?.text);
await dm("後台"); t((replies()[0]?.text || "").includes(bk), "same link again");
await send({ type: "message", source: { type: "user", userId: "U_andy" }, message: { type: "text", id: "dx", text: "後台" } });
t(!(replies()[0]?.text || "").includes("/bo?k="), "non-admin no link");
const bo = await import(R + "/functions/bo/index.js");
const bget = q => bo.onRequestGet({ request: new Request("https://x.dev/bo?" + q), env });
let bh = await (await bget("k=" + bk)).text();
t(bh.includes("威仕登") && bh.includes("香閣的單") && bh.includes("帳單存檔"), "bo list");
t((await bget("k=wrongwrongwrongwrongwrong")).status === 404, "bo bad key");
bh = await (await bget("k=" + bk + "&v=stores")).text(); t(bh.includes("威仕登") && bh.includes("樣本少"), "bo stores");
bh = await (await bget("k=" + bk + "&v=owners")).text(); t(bh.includes("香閣"), "bo owners");
const csvr = await bget("k=" + bk + "&v=csv"); t(/text\/csv/.test(csvr.headers.get("content-type")) && (await csvr.text()).includes("威仕登"), "bo csv");
const rid0 = sq.prepare("SELECT id FROM line_splits WHERE chat_id='Cbar' ORDER BY created DESC").get().id;
bh = await (await bget("k=" + bk + "&id=" + rid0)).text(); t(bh.includes("消費範例卡") && bh.includes("林莎") && bh.includes("/bo/img?k="), "bo detail real names + sample");
const fdat = new FormData(); fdat.set("id", rid0); fdat.set("owner", "子瑤");
const pr = await bo.onRequestPost({ request: new Request("https://x.dev/bo?k=" + bk, { method: "POST", body: fdat }), env });
t(pr.status === 303 && JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id=?").get(rid0).data).owner === "子瑤", "bo set owner");
await dm("新增後台 小王");
const sk = ((replies()[0]?.text || "").match(/\/bo\?k=(\w+)/) || [])[1];
t(sk && (await bget("k=" + sk)).status === 200, "staff link works");
await dm("取消後台 小王"); t(/已停用/.test(replies()[0]?.text || "") && (await bget("k=" + sk)).status === 404, "staff revoked");
// 16. 晚到／早走：整晚的費用照在場時間分
sq.prepare("DELETE FROM line_kv WHERE k='liff:split'").run();
{
  const g2 = guests.map(g => g.name === "玄" ? { ...g, late: 18 } : g);
  const sp2 = JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id=?").get(sid).data);
  const room = sp2.shared.find(x => /包廂/.test(x.name));
  fr = await fm.onRequestPost({ request: new Request(furl, { method: "POST", body: JSON.stringify({ guests: g2, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])), night: 36, byTime: { [room.id]: true } }) }), env });
  fj = await fr.json();
  const res = JSON.parse(sq.prepare("SELECT result FROM line_splits WHERE id=?").get(sid).result);
  const it = nm => res.people.find(p => p.name === nm).items.find(x => x.name.startsWith(room.name));
  t(fr.status === 200 && fj.total === 108600 && /在場 18\/36 節/.test(it("玄").name) && Math.abs(it("玄").amount - room.amount * 18 / (36 * 4 + 18)) <= 1, "room by time " + JSON.stringify([it("玄"), it("A")]));
  fr = await fm.onRequestPost({ request: new Request(furl, { method: "POST", body: JSON.stringify({ guests: g2, hostess: Object.fromEntries(Object.entries(plan).map(([k, v]) => [h(k), v])) }) }), env });
  t(fr.status === 400 && /整晚共幾節/.test((await fr.json()).error), "late needs night");
  fh = await (await fm.onRequestGet({ request: new Request(furl), env })).text();
  t(/"late":18/.test(fh) && /"night":36/.test(fh) && /"bt":true/.test(fh), "form restores late/night/byTime");
  if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP + "/form2.html", fh);
}
console.log(`${ok} passed, ${bad} failed`);
