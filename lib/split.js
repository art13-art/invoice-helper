// 拆酒店帳單：幹部在群組貼帳單 → 讀帳單 → 在群組 @Ben 問人數、名字、男女、誰併給誰
// → 小姐指派卡（這位坐哪位客人）＋公費卡（預設全部平分，按名字排除／加回）→ 完成 → @All「拆帳完畢」＋請款卡。
// 只有管理員能按卡片、回答人名。金額算到個位數，加總一定等於帳單現金價格。
import { claude, kv, rid, isGroup } from "./assistant.js";
import { recordAI } from "./usage.js";
import { toBlocks } from "./files.js";
import { mentionMessage, textMessage } from "./line.js";

const HOUR = 3600e3;
const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280", soft: "#EEF2F1", line: "#E5E7EB", warn: "#B45309", accent: "#F28C28" };
export const SPLIT_SQL = `CREATE TABLE IF NOT EXISTS line_splits (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, bill_no TEXT, created INTEGER NOT NULL, created_by TEXT, status TEXT NOT NULL, data TEXT NOT NULL, result TEXT, done_at INTEGER);
CREATE INDEX IF NOT EXISTS line_splits_chat ON line_splits(chat_id, created);
CREATE TABLE IF NOT EXISTS line_split_imgs (split_id TEXT NOT NULL, n INTEGER NOT NULL, mime TEXT, data BLOB, PRIMARY KEY (split_id, n));`;

export const fmt = n => Math.round(Number(n) || 0).toLocaleString("en-US");
export const splitOn = async (db, chatId) => (await kv.get(db, "split:on:" + chatId)) === "1";
export async function splitToken(db, chatId) {
  let t = await kv.get(db, "split:tok:" + chatId);
  if (!t) { t = rid(12) + rid(12); await kv.set(db, "split:tok:" + chatId, t); await kv.set(db, "splittok:" + t, chatId); }
  return t;
}
const load = async (db, id) => { const r = await db.prepare("SELECT * FROM line_splits WHERE id=?").bind(id).first(); if (r) r.d = JSON.parse(r.data || "{}"); return r; };
const save = (db, r) => db.prepare("UPDATE line_splits SET data=?, status=?, bill_no=? WHERE id=?").bind(JSON.stringify(r.d), r.status, r.d.bill_no || null, r.id).run();
/* 這個群組進行中的那張（24 小時內） */
export const openSplit = async (db, chatId) => {
  const r = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status IN ('ask','pick') AND created>? ORDER BY created DESC LIMIT 1").bind(chatId, Date.now() - 24 * HOUR).first();
  if (r) r.d = JSON.parse(r.data || "{}");
  return r;
};

/* ---------- 讀帳單 ---------- */
const json = t => { try { return JSON.parse((String(t).match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch (e) { return {}; } };
async function ai(env, db, chatId, body) {
  const res = await claude(env, body);
  if (res.usage) await recordAI(env, db, { chatId, model: body.model, usage: res.usage }).catch(() => {});
  return (res.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
/* 自動模式：便宜的 Haiku 先看是不是帳單（約 US$0.002／張） */
export async function looksLikeBill(env, db, chatId, img) {
  const t = await ai(env, db, chatId, { model: env.BG_MODEL || "claude-haiku-5-5", max_tokens: 80,
    system: "判斷照片是不是酒店、KTV、酒吧或餐廳的消費帳單／結帳單／消費明細。只回 JSON：{\"bill\":true或false,\"bill_no\":\"單號，看不到就空字串\"}",
    messages: [{ role: "user", content: [...(await toBlocks(img.bytes, img.type, "帳單.jpg")), { type: "text", text: "這是帳單嗎？" }] }] });
  const j = json(t);
  return j.bill === true ? { bill_no: String(j.bill_no || "").trim() } : null;
}
const EXTRACT = `你是酒店／KTV 帳單判讀。照片都是同一張帳單（可能分成「消費明細」和「結帳單」兩張）。只回 JSON，不要其他字：
{"store":"店名","bill_no":"單號","date":"M/D","guests_note":"帳單上的人數標示，例如 5+0",
 "cash_total":現金價格（數字）,"card_total":刷卡價格（數字或 null）,
 "hostess":[{"name":"小姐名字（只寫印刷的字）","mark":"名字旁邊手寫的代號，沒有就空字串","type":"坐檯／點檯／小框／全場／外全／訪檯…","time":"時間","units":節數,"amount":金額}],
 "shared":[{"name":"品名","qty":數量,"price":單價,"amount":金額,"cat":"酒／餐／包廂／低消／雜支／小費／服務費／其他"}],
 "free":["招待或 0 元的品名"],
 "note":"一句話：有沒有看不清楚或對不上的地方"}
規則：
- hostess＝代支（小姐的檯費）每一行；同一位小姐有好幾行就分開列。
- shared＝其他所有要付錢的項目：明細裡非代支的每一行（酒、餐、煙、小費…），加上只出現在結帳單的項目（包廂費、人頭低消、服務費…）。
- 不要重複：結帳單上的「酒」「餐」「代支」「雜支」「小計」是明細的合計，明細裡已經有細項就不要再列；明細沒有的類別才用結帳單的金額。
- 招待、0 元的放 free。手寫的拆帳金額、手寫的總數不要算進任何項目。
- cash_total 用「現金價格」；沒有就用最後的總計。數字不要千分位。`;
export async function extractBill(env, db, chatId, imgs) {
  const content = [];
  for (const [i, im] of imgs.entries()) { content.push({ type: "text", text: `第 ${i + 1} 張：` }, ...(await toBlocks(im.bytes, im.type, "帳單.jpg"))); }
  content.push({ type: "text", text: "請讀這張帳單。" });
  const t = await ai(env, db, chatId, { model: env.CHAT_MODEL || "claude-sonnet-5-5", max_tokens: 4000, system: EXTRACT, messages: [{ role: "user", content }] });
  return normalize(json(t));
}
/* 整理成可以拆的樣子：小姐依名字合併；加總和現金價格差一點（店家進位）就加一行「差額」平分 */
export function normalize(b) {
  const num = v => Math.round(Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0);
  const hs = new Map();
  for (const h of b.hostess || []) {
    const name = String(h.name || "").replace(/[\s*＊]/g, "").trim() || "小姐";
    const g = hs.get(name) || { name, marks: [], lines: [], amount: 0 };
    g.lines.push({ type: h.type || "", time: h.time || "", units: num(h.units), amount: num(h.amount) });
    g.amount += num(h.amount);
    if (h.mark && !g.marks.includes(String(h.mark).trim())) g.marks.push(String(h.mark).trim());
    hs.set(name, g);
  }
  const hostess = [...hs.values()].map((g, i) => ({ ...g, id: "h" + i, mark: g.marks.join("／"), guest: null }));
  const shared = (b.shared || []).map(s => ({ name: String(s.name || "項目"), qty: num(s.qty) || 1, price: num(s.price), amount: num(s.amount), cat: s.cat || "其他" })).filter(s => s.amount);
  const sum = hostess.reduce((a, h) => a + h.amount, 0) + shared.reduce((a, s) => a + s.amount, 0);
  const cash = num(b.cash_total) || sum, diff = cash - sum;
  let warn = b.note && !/沒有|無|對得上|正確/.test(b.note) ? String(b.note) : "";
  if (diff && Math.abs(diff) <= Math.max(1000, cash * 0.02)) shared.push({ name: diff > 0 ? "差額（店家進位）" : "差額（店家折讓）", qty: 1, price: diff, amount: diff, cat: "其他" });
  else if (diff) warn = `讀到的項目加起來 ${fmt(sum)}，跟現金價格 ${fmt(cash)} 差 ${fmt(diff)}，請看一下是不是有項目沒讀到。` + (warn ? "\n" + warn : "");
  shared.forEach((s, i) => { s.id = "s" + i; s.who = null; });   // who＝null 代表全部平分
  return { store: b.store || "", bill_no: String(b.bill_no || "").trim(), date: b.date || "", guests_note: b.guests_note || "",
    cash, card: num(b.card_total) || null, hostess, shared, free: b.free || [], warn, sum: sum + (diff && Math.abs(diff) <= Math.max(1000, cash * 0.02) ? diff : 0) };
}

/* ---------- 開一張新的拆帳（或把第二張照片併進同一張） ---------- */
export async function startSplit(env, db, { chatId, userId, imgs, billNo }) {
  const now = Date.now();
  // 同一張單的第二張照片（同單號，或 15 分鐘內沒單號）：併進去重讀
  const open = await openSplit(db, chatId);
  let r = open && ((billNo && open.bill_no && billNo.replace(/\s/g, "") === open.bill_no.replace(/\s/g, "")) || ((!billNo || !open.bill_no) && now - open.created < 15 * 60e3)) ? open : null;
  const old = r ? await db.prepare("SELECT n,mime,data FROM line_split_imgs WHERE split_id=? ORDER BY n").bind(r.id).all() : { results: [] };
  const all = [...old.results.map(x => ({ type: x.mime, bytes: new Uint8Array(x.data) })), ...imgs].slice(0, 4);
  const d = await extractBill(env, db, chatId, all);
  if (!d.hostess.length && !d.shared.length) return { error: "這張我讀不出帳單內容，可以再拍清楚一點嗎？" };
  if (r) {
    // 已經回答過的人名、指派保留
    const keep = r.d;
    d.guests = keep.guests || []; d.merge = keep.merge || {};
    for (const h of d.hostess) { const o = (keep.hostess || []).find(x => x.name === h.name); if (o) h.guest = o.guest; }
    for (const s of d.shared) { const o = (keep.shared || []).find(x => x.name === s.name && x.amount === s.amount); if (o) s.who = o.who; }
    r.d = d; await save(db, r);
  } else {
    r = { id: rid(8), status: "ask", d: { ...d, guests: [], merge: {} } };
    await db.prepare("INSERT INTO line_splits(id,chat_id,bill_no,created,created_by,status,data) VALUES(?,?,?,?,?,?,?)").bind(r.id, chatId, d.bill_no || null, now, userId || null, "ask", JSON.stringify(r.d)).run();
  }
  let n = old.results.length;
  for (const im of imgs) if (n < 4 && im.bytes.length < 1.9 * 1024 * 1024) await db.prepare("INSERT OR REPLACE INTO line_split_imgs(split_id,n,mime,data) VALUES(?,?,?,?)").bind(r.id, n++, im.type || "image/jpeg", im.bytes.buffer.slice(im.bytes.byteOffset, im.bytes.byteOffset + im.bytes.byteLength)).run();   // D1：ArrayBuffer 存成 BLOB
  return { split: r, merged: !!open && r.id === open.id, photos: all.length };
}

/* ---------- 問 Ben：幾人、名字、男女、誰併給誰 ---------- */
export function askMessages(r, adminId, merged) {
  const d = r.d, hostSum = d.hostess.reduce((a, h) => a + h.amount, 0), sharedSum = d.shared.reduce((a, s) => a + s.amount, 0);
  const row = (k, v, bold) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: k, size: "sm", color: C.sub, flex: 3 }, { type: "text", text: v, size: "sm", color: C.ink, align: "end", flex: 5, wrap: true, ...(bold ? { weight: "bold" } : {}) }] });
  const card = { type: "flex", altText: `帳單讀好了：現金 $${fmt(d.cash)}`, contents: { type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
      { type: "text", text: merged ? "帳單已更新" : "帳單讀好了", color: "#FFFFFF", weight: "bold", size: "md" },
      { type: "text", text: [d.store, d.date, d.bill_no].filter(Boolean).join("｜") || "帳單", color: "#CFE3E1", size: "xs", wrap: true, margin: "xs" }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "sm", contents: [
      { type: "text", text: "$" + fmt(d.cash), size: "xxl", weight: "bold", color: C.ink },
      { type: "text", text: "現金價格" + (d.card ? `（刷卡 $${fmt(d.card)}）` : ""), size: "xs", color: C.sub },
      { type: "separator", margin: "md", color: C.line },
      row("小姐代支", `${d.hostess.length} 位｜$${fmt(hostSum)}`),
      row("公費", `${d.shared.length} 項｜$${fmt(sharedSum)}`),
      ...(d.guests_note ? [row("帳單人數", d.guests_note)] : []),
      d.warn ? { type: "text", text: "⚠ " + d.warn, size: "xs", color: C.warn, wrap: true, margin: "md" } : { type: "text", text: "✓ 加總和現金價格對得上", size: "xs", color: C.brand, margin: "md" }] } } };
  const ex = "例如：@小幫手 5人 Tom男 Jack男 Amy女 Leo男 Ken男，Amy 併 Tom";
  return [mentionMessage(`{who} ${merged ? "第二張照片也讀進來了。" : "帳單讀好了。"}請回我：幾人、名字、男女、誰的帳要合併給誰請款\n${ex}`, adminId), card];
}
/* 解析 Ben 的回答（Haiku）：不是在回答就回 null */
export async function parseGuests(env, db, chatId, text) {
  const t = await ai(env, db, chatId, { model: env.BG_MODEL || "claude-haiku-5-5", max_tokens: 500,
    system: `群組正在拆一張酒店帳單，小幫手問了「幾人、名字、男女、誰的帳要合併給誰請款」。判斷這句話是不是在回答這個問題。只回 JSON：
是：{"answer":true,"count":人數或 null,"guests":[{"name":"名字","sex":"男／女／空字串"}],"merge":[{"from":"被合併的人","to":"請款對象"}]}
不是（在說別的事）：{"answer":false}
名字照原文，不要翻譯；「Amy 算 Tom 的」「Amy、Ken 跟 Tom 收」都是合併。`,
    messages: [{ role: "user", content: text }] });
  const j = json(t);
  if (!j.answer || !Array.isArray(j.guests) || !j.guests.length) return null;
  const seen = new Set(), guests = [];
  for (const g of j.guests) { const name = String(g.name || "").trim().slice(0, 20); if (name && !seen.has(name)) { seen.add(name); guests.push({ id: "g" + guests.length, name, sex: /女/.test(g.sex) ? "女" : /男/.test(g.sex) ? "男" : "" }); } }
  const merge = {};
  for (const m of j.merge || []) { const f = guests.find(g => g.name === String(m.from).trim()), to = guests.find(g => g.name === String(m.to).trim()); if (f && to && f.id !== to.id) merge[f.id] = to.id; }
  return { count: Number(j.count) || null, guests: guests.slice(0, 12), merge };
}
export async function setGuests(db, r, p) {
  const old = r.d.guests || [];
  r.d.guests = p.guests; r.d.merge = p.merge;
  const map = id => { const o = old.find(g => g.id === id); return o ? (p.guests.find(g => g.name === o.name) || {}).id || null : null; };
  for (const h of r.d.hostess) h.guest = h.guest ? map(h.guest) : null;
  for (const s of r.d.shared) s.who = s.who ? s.who.map(map).filter(Boolean) : null;
  // 只有一位客人時，小姐全部算他的
  if (p.guests.length === 1) for (const h of r.d.hostess) h.guest = p.guests[0].id;
  r.status = "pick";
  await save(db, r);
}

/* ---------- 卡片 ---------- */
const btn = (label, data, primary) => ({ type: "button", height: "sm", style: primary ? "primary" : "secondary", color: primary ? C.brand : C.soft, flex: 1,
  action: { type: "postback", label: String(label).slice(0, 20), data } });
const grid = (buttons, per = 2) => { const rows = []; for (let i = 0; i < buttons.length; i += per) rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: [...buttons.slice(i, i + per), ...Array(per - buttons.slice(i, i + per).length).fill({ type: "box", layout: "vertical", contents: [], flex: 1 })] }); return rows; };
const gname = g => g.name + (g.sex ? `（${g.sex}）` : "");
function hostessBubble(r, h) {
  const d = r.d;
  return { type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: C.soft, paddingAll: "12px", contents: [
      { type: "text", text: "小姐｜" + h.name, weight: "bold", size: "md", color: C.brand },
      { type: "text", text: `$${fmt(h.amount)}｜${h.lines.length} 筆｜${h.lines.reduce((a, l) => a + l.units, 0)} 節` + (h.mark ? `｜標記 ${h.mark}` : ""), size: "xs", color: C.sub, wrap: true }] },
    body: { type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm", contents: [
      { type: "text", text: "坐哪位客人？", size: "xs", color: C.sub },
      ...grid(d.guests.map(g => btn(gname(g), `sp:${r.id}:h:${h.id}:${g.id}`, false)))] } };
}
function sharedBubble(r, s) {
  const d = r.d;
  return { type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: "#FFF4E8", paddingAll: "12px", contents: [
      { type: "text", text: "公費｜" + s.name, weight: "bold", size: "md", color: C.ink, wrap: true, maxLines: 2 },
      { type: "text", text: `$${fmt(s.amount)}` + (s.qty > 1 ? `｜${s.qty} × ${fmt(s.price)}` : ""), size: "xs", color: C.sub }] },
    body: { type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm", contents: [
      { type: "text", text: "預設全部平分。按名字＝排除／加回", size: "xs", color: C.sub, wrap: true },
      ...grid(d.guests.map(g => btn(g.name, `sp:${r.id}:s:${s.id}:${g.id}`, false))),
      btn("全部平分", `sp:${r.id}:sa:${s.id}`, true)] } };
}
export function pickMessages(r) {
  const d = r.d, bubbles = [...d.hostess.filter(h => d.guests.length > 1 || !h.guest).map(h => hostessBubble(r, h)), ...d.shared.map(s => sharedBubble(r, s))];
  const out = [];
  for (let i = 0; i < bubbles.length && out.length < 3; i += 12) out.push({ type: "flex", altText: "拆帳：小姐指派、公費分攤", contents: { type: "carousel", contents: bubbles.slice(i, i + 12) } });
  const who = d.guests.map(g => gname(g) + (d.merge[g.id] ? `→併 ${d.guests.find(x => x.id === d.merge[g.id]).name}` : "")).join("、");
  out.unshift(textMessage(`好，${d.guests.length} 位：${who}\n左右滑：小姐卡按她坐的客人；公費卡預設全部平分，有人沒份就按他的名字排除。點完按「完成」。`));
  out.push({ type: "flex", altText: "點完按完成", contents: { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "sm", contents: [
    { type: "text", text: "全部點完按「完成」", weight: "bold", size: "sm", color: C.brand },
    { type: "text", text: "只有 Ben 能按。點錯再按一次就好。", size: "xs", color: C.sub },
    btn("完成", `sp:${r.id}:ok`, true),
    { type: "box", layout: "horizontal", spacing: "sm", contents: [btn("目前狀況", `sp:${r.id}:st`, false), btn("取消這張", `sp:${r.id}:x`, false)] }] } } });
  return out.slice(0, 5);
}

/* ---------- 計算：精確分攤，最後四捨五入到個位數並讓加總剛好等於帳單 ---------- */
export function compute(d) {
  const ids = d.guests.map(g => g.id), raw = Object.fromEntries(ids.map(id => [id, { hostess: 0, shared: 0, items: [] }]));
  for (const h of d.hostess) if (h.guest && raw[h.guest]) { raw[h.guest].hostess += h.amount; raw[h.guest].items.push({ name: "小姐｜" + h.name, amount: h.amount }); }
  for (const s of d.shared) {
    const who = (s.who && s.who.length ? s.who : ids).filter(id => raw[id]);
    for (const id of who) { raw[id].shared += s.amount / who.length; raw[id].items.push({ name: s.name + (who.length > 1 ? `（${who.length} 人分）` : ""), amount: s.amount / who.length }); }
  }
  const exact = ids.map(id => raw[id].hostess + raw[id].shared), target = Math.round(exact.reduce((a, b) => a + b, 0));
  const fl = exact.map(Math.floor); let left = target - fl.reduce((a, b) => a + b, 0);
  exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  const people = d.guests.map((g, i) => ({ id: g.id, name: g.name, sex: g.sex, total: fl[i], hostess: raw[g.id].hostess, shared: Math.round(raw[g.id].shared), items: raw[g.id].items.map(x => ({ ...x, amount: Math.round(x.amount) })) }));
  const payers = [];
  for (const p of people) {
    const to = d.merge[p.id] || p.id;
    let pay = payers.find(x => x.id === to);
    if (!pay) { const g = people.find(x => x.id === to); pay = { id: to, name: g.name, total: 0, includes: [] }; payers.push(pay); }
    pay.total += p.total;
    if (to !== p.id) pay.includes.push({ name: p.name, total: p.total });
  }
  payers.sort((a, b) => d.guests.findIndex(g => g.id === a.id) - d.guests.findIndex(g => g.id === b.id));
  return { total: target, people, payers };
}
export function statusText(d) {
  const nm = id => (d.guests.find(g => g.id === id) || {}).name || "?";
  const un = d.hostess.filter(h => !h.guest);
  const res = compute(d);
  return [`小姐：${d.hostess.length - un.length}/${d.hostess.length} 位已指定` + (un.length ? `（還沒：${un.map(h => h.name).join("、")}）` : ""),
    ...d.hostess.filter(h => h.guest).map(h => `・${h.name} → ${nm(h.guest)}`),
    "公費：" + (d.shared.some(s => s.who) ? d.shared.filter(s => s.who).map(s => `${s.name} 只算 ${s.who.map(nm).join("、")}`).join("；") + "；其他全部平分" : "全部平分"),
    "目前試算：" + res.people.map(p => `${p.name} ${fmt(p.total)}`).join("、")].join("\n");
}

/* 請款卡 */
export function resultCard(r, res, url) {
  const d = r.d;
  const rows = res.payers.flatMap((p, i) => {
    const person = res.people.find(x => x.id === p.id);
    return [...(i ? [{ type: "separator", color: C.line }] : []), { type: "box", layout: "vertical", spacing: "xs", contents: [
      { type: "box", layout: "horizontal", alignItems: "center", contents: [
        { type: "text", text: p.name, size: "md", weight: "bold", color: C.ink, flex: 5, wrap: true },
        { type: "text", text: "$" + fmt(p.total), size: "lg", weight: "bold", color: C.brand, align: "end", flex: 5 }] },
      { type: "text", text: `小姐 ${fmt(person.hostess)}｜公費 ${fmt(person.shared)}`, size: "xxs", color: C.sub },
      ...p.includes.map(x => ({ type: "text", text: `＋ 含 ${x.name} $${fmt(x.total)}`, size: "xs", color: C.accent }))] }];
  });
  return { type: "flex", altText: "請款單：" + res.payers.map(p => `${p.name} $${fmt(p.total)}`).join("、"), contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "16px", contents: [
      { type: "text", text: "請款單", color: "#CFE3E1", size: "xs" },
      { type: "text", text: [d.store, d.date].filter(Boolean).join("｜") || "帳單", color: "#FFFFFF", weight: "bold", size: "lg", wrap: true },
      { type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: "現金總額", color: "#CFE3E1", size: "sm", flex: 1, gravity: "bottom" },
        { type: "text", text: "$" + fmt(res.total), color: "#FFFFFF", weight: "bold", size: "xl", align: "end", flex: 2 }] }] },
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "md", contents: rows },
    footer: { type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", spacing: "sm", contents: [
      { type: "text", text: `${d.guests.length} 人｜${d.hostess.length} 位小姐｜金額算到個位數`, size: "xxs", color: C.sub, align: "center" },
      ...(url ? [{ type: "button", style: "primary", color: C.brand, height: "sm", action: { type: "uri", label: "查看明細", uri: url } }] : [])] } } };
}

/* ---------- 按鈕 ---------- */
export async function splitPostback(env, db, { chatId, userId, data, isAdmin, origin }) {
  const m = data.match(/^sp:(\w+):(h|s|sa|ok|st|x)(?::(\w+))?(?::(\w+))?$/);
  if (!m) return null;
  if (!isAdmin) return [textMessage("拆帳只有 Ben 能按。")];
  const r = await load(db, m[1]);
  if (!r || r.chat_id !== chatId) return [textMessage("找不到這張帳單。")];
  if (r.status === "done") return [textMessage("這張已經拆完了。")];
  if (r.status === "cancelled") return [textMessage("這張已經取消了。")];
  const d = r.d, nm = id => (d.guests.find(g => g.id === id) || {}).name;
  const [, , act, a, b] = m;
  if (act === "h") {
    const h = d.hostess.find(x => x.id === a); if (!h || !nm(b)) return null;
    h.guest = b; await save(db, r);
    const done = d.hostess.filter(x => x.guest).length;
    return [textMessage(`${h.name} → ${nm(b)}（小姐 ${done}/${d.hostess.length}）`)];
  }
  if (act === "s" || act === "sa") {
    const s = d.shared.find(x => x.id === a); if (!s) return null;
    if (act === "sa") s.who = null;
    else { const all = d.guests.map(g => g.id), cur = s.who || all; s.who = cur.includes(b) ? cur.filter(x => x !== b) : [...cur, b].sort((x, y) => all.indexOf(x) - all.indexOf(y)); if (s.who.length === all.length) s.who = null; }
    if (s.who && !s.who.length) { s.who = null; await save(db, r); return [textMessage(`${s.name} 至少要有一個人付，改回全部平分。`)]; }
    await save(db, r);
    return [textMessage(`${s.name}：${s.who ? s.who.map(nm).join("、") + `（${s.who.length} 人分）` : "全部平分"}`)];
  }
  if (act === "st") return [textMessage(statusText(d))];
  if (act === "x") { r.status = "cancelled"; await save(db, r); return [textMessage("好，這張拆帳取消了。")]; }
  // 完成
  const un = d.hostess.filter(h => !h.guest);
  if (un.length) return [textMessage(`還有 ${un.length} 位小姐沒指定客人：${un.map(h => h.name).join("、")}`)];
  const res = compute(d);
  const lock = await db.prepare("UPDATE line_splits SET status='done', result=?, done_at=? WHERE id=? AND status='pick'").bind(JSON.stringify(res), Date.now(), r.id).run();
  if ((lock.meta?.changes ?? 1) === 0) return [textMessage("這張已經拆完了。")];
  const url = origin ? `${origin}/split?t=${await splitToken(db, chatId)}&id=${r.id}` : null;
  return [mentionMessage("{who} 拆帳完畢", "all"), resultCard(r, res, url)];
}
