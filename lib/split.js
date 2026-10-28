// 拆酒店帳單：幹部在群組貼帳單 → 讀帳單 → 在群組 @Ben 問人數、名字、男女、誰併給誰
// → 小姐指派卡（這位坐哪位客人）＋公費卡（預設全部平分，按名字排除／加回）→ 完成 → @All「拆帳完畢」＋請款卡。
// 只有管理員能按卡片、回答人名。金額算到個位數，加總一定等於帳單現金價格。
import { claude, kv, rid, isGroup } from "./assistant.js";
import { recordAI, recordPush } from "./usage.js";
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
  const t = await ai(env, db, chatId, { model: env.BG_MODEL || "claude-haiku-5-5", max_tokens: 300,
    system: "判斷這張照片是不是消費帳單：酒店、KTV、酒吧、餐廳的結帳單、消費明細、收據、簽單都算（有品項或費用名稱加上金額，手寫的也算）。只回 JSON：{\"bill\":true或false,\"bill_no\":\"單號，看不到就空字串\"}",
    messages: [{ role: "user", content: [...(await toBlocks(img.bytes, img.type, "帳單.jpg")), { type: "text", text: "這是消費帳單嗎？" }] }] });
  // 留最後一次的判斷，查問題用
  await kv.set(db, "split:diag:" + chatId, JSON.stringify({ ts: Date.now(), type: img.type, size: img.bytes.length, raw: String(t).slice(0, 300) })).catch(() => {});
  const j = json(t);
  const yes = j.bill === true || j.bill === "true" || (!("bill" in j) && /"?bill"?\s*[:：]\s*"?true/i.test(t));
  return yes ? { bill_no: String(j.bill_no || "").trim() } : null;
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
  const t = await ai(env, db, chatId, { model: env.CHAT_MODEL || "claude-sonnet-5-5", max_tokens: 16000, system: EXTRACT, messages: [{ role: "user", content }] });
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
export function askMessages(r, adminId, merged, formUrl) {
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
      d.warn ? { type: "text", text: "⚠ " + d.warn, size: "xs", color: C.warn, wrap: true, margin: "md" } : { type: "text", text: "✓ 加總和現金價格對得上", size: "xs", color: C.brand, margin: "md" }] },
    ...(formUrl ? { footer: { type: "box", layout: "vertical", paddingAll: "14px", paddingTop: "0px", spacing: "sm", contents: [
      { type: "button", style: "primary", color: C.brand, height: "md", action: { type: "uri", label: "開始拆帳", uri: formUrl } },
      { type: "text", text: "在表單裡填客人、小姐坐誰、公費誰分，送出就結算", size: "xxs", color: C.sub, wrap: true, align: "center" }] } } : {}) } };
  return [mentionMessage(`{who} ${merged ? "第二張照片也讀進來了。" : "帳單讀好了。"}按「開始拆帳」填表，送出後我結算、貼請款單。`, adminId), card];
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

/* ---------- 舊版卡片的按鈕（現在改用表單） ---------- */
export async function splitPostback(env, db, { chatId, data, isAdmin, origin }) {
  const m = data.match(/^sp:(\w+):/);
  if (!m) return null;
  if (!isAdmin) return [textMessage("拆帳只有 Ben 能操作。")];
  const r = await load(db, m[1]);
  if (!r || r.chat_id !== chatId) return [textMessage("找不到這張帳單。")];
  const url = origin ? `${origin}/split/form?t=${await splitToken(db, chatId)}&id=${r.id}` : "";
  return [textMessage("拆帳改成用表單填了，點這裡：\n" + url)];
}

/* ---------- 表單送出：套用名單、指派、分攤 → 結算 → @All 拆帳完畢＋請款卡（推播） ---------- */
export async function finishForm(env, db, line, { chatId, id, body, origin }) {
  const r = await load(db, id);
  if (!r || r.chat_id !== chatId) return { error: "找不到這張帳單" };
  if (r.status === "cancelled") return { error: "這張已經取消了" };
  const { guests, merge } = cleanDraft(body);
  if (!guests.length) return { error: "至少要填一位客人" };
  const byName = n => guests.find(g => g.name === String(n || "").trim());
  const d = r.d, assign = body.hostess || {}, share = body.shared || {};
  const miss = [];
  for (const h of d.hostess) { const g = byName(assign[h.id]); if (g) h.guest = g.id; else { h.guest = null; miss.push(h.name); } }
  if (miss.length) return { error: "還有小姐沒選客人：" + miss.join("、") };
  for (const sh of d.shared) {
    const v = share[sh.id];
    if (!Array.isArray(v)) { sh.who = null; continue; }
    const ids = v.map(byName).filter(Boolean).map(g => g.id);
    if (!ids.length) return { error: `「${sh.name}」至少要有一個人分` };
    sh.who = ids.length === guests.length ? null : ids;
  }
  d.guests = guests; d.merge = merge;
  const res = compute(d), fix = r.status === "done";
  d.formAt = Date.now();
  await db.prepare("UPDATE line_splits SET data=?, status='done', result=?, done_at=? WHERE id=?").bind(JSON.stringify(d), JSON.stringify(res), Date.now(), r.id).run();
  const url = origin ? `${origin}/split?t=${await splitToken(db, chatId)}&id=${r.id}` : null;
  r.d = d;
  let posted = false;
  try {
    await line.push(chatId, [mentionMessage(fix ? "{who} 拆帳更正（以這張為準）" : "{who} 拆帳完畢", "all"), resultCard(r, res, url)]);
    posted = true;
    await recordPush(db, chatId, await line.memberCount(chatId)).catch(() => {});
  } catch (e) { console.log("split push failed", e.message); }
  return { ok: true, posted, fix, total: res.total, payers: res.payers.map(p => ({ name: p.name, total: p.total, includes: p.includes })) };
}

/* 表單的客人名單：去重、併給的人一路找到最後付錢的人 */
export function cleanDraft(input) {
  const rows = (Array.isArray(input?.guests) ? input.guests : []).slice(0, 12);
  const guests = [], seen = new Set();
  for (const g of rows) { const name = String(g.name || "").replace(/\s+/g, " ").trim().slice(0, 20); if (name && !seen.has(name)) { seen.add(name); guests.push({ id: "g" + guests.length, name, sex: g.sex === "女" ? "女" : g.sex === "男" ? "男" : "", to: String(g.to || "").trim() }); } }
  const merge = {};
  for (const g of guests) {
    // 併給的人如果自己也併給別人，一路找到最後付錢的人（避免繞圈）
    let to = guests.find(x => x.name === g.to), hops = 0;
    while (to && to.to && hops++ < 12) { const nx = guests.find(x => x.name === to.to); if (!nx || nx.id === g.id) break; to = nx; }
    if (to && to.id !== g.id) merge[g.id] = to.id;
  }
  return { guests: guests.map(({ to, ...g }) => g), merge };
}
export { load as loadSplit };
