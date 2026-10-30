// 帳單欄位化：每張拆帳紀錄整理成固定欄位（店、日期、人數、時長、每節價、包廂、桌面、小費、酒水、刷卡加成…），
// 給後台列表、行情統計和「消費範例卡」（人名換成假名）用。全部是程式計算，不用 AI。
import { fmt } from "./split.js";

const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280", soft: "#EEF2F1", line: "#E5E7EB", accent: "#F28C28" };

/* 店名統一：全形轉半形、去空白、英文大寫（SS、ＳＳ、s s 都算同一家） */
export function normStore(s) {
  return String(s || "").replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, "").toUpperCase() || "未知";
}

/* 公費項目分類 */
export function itemKind(s) {
  const n = String(s.name || "");
  if (/包廂|包箱|低消|房費/.test(n)) return "room";
  if (/經理檯|經理台|主管檯/.test(n)) return "manager";
  if (/桌面|清潔|麥克風|水錢|開瓶/.test(n)) return "table";
  if (/小費|服務費/.test(n)) return "tip";
  if (/人頭|女客|男客/.test(n)) return "head";
  if (/差額/.test(n)) return "diff";
  if (/代駕|趴車|叫車|接送/.test(n)) return "ride";
  if (s.cat === "酒" || /酒|啤|威士忌|DM|麥卡倫|約翰|皇家|軒尼詩|干邑|XO|香檳|紅酒|白蘭地|高粱|清酒|\/\d{2}/i.test(n)) return "drink";
  if (s.cat === "餐" || /薯條|果盤|水果|點心|炒|麵|飯|拼盤/.test(n)) return "food";
  return "other";
}
const OUT = /出場|外全|大框|小框|框/;

/* 帳單上的時間「10-3~01-2」：時-第幾個 10 分鐘。晚上 8 點以後到早上 7 點算同一晚 */
function toMin(t) {
  const m = String(t).match(/(\d{1,2})\s*[-:：]\s*(\d)/);
  if (!m) return null;
  let h = +m[1];
  h = h <= 7 ? h + 24 : h < 12 ? h + 12 : h === 12 ? 24 : h;
  return h * 60 + +m[2] * 10;
}
export function duration(d) {
  let lo = Infinity, hi = -Infinity;
  for (const h of d.hostess || []) for (const l of h.lines || []) {
    if (OUT.test(l.type || "")) continue;
    const [a, b] = String(l.time || "").split(/~|～/);
    const s = toMin(a), e = b == null ? null : toMin(b);
    if (s != null && e != null && e > s) { lo = Math.min(lo, s); hi = Math.max(hi, e); }
  }
  return hi > lo ? hi - lo : null;
}
export const durText = m => (m == null ? "" : m % 60 ? `約 ${Math.floor(m / 60)} 小時 ${m % 60} 分` : `約 ${m / 60} 小時`);
const median = a => { const s = a.filter(x => x > 0).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

/* 一筆拆帳紀錄 → 固定欄位 */
export function facts(row) {
  const d = typeof row.data === "string" ? JSON.parse(row.data || "{}") : row.data || row.d || {};
  const res = row.result ? (typeof row.result === "string" ? JSON.parse(row.result) : row.result) : null;
  const sum = k => (d.shared || []).filter(s => itemKind(s) === k).reduce((a, s) => a + (s.amount || 0), 0);
  const lines = (d.hostess || []).flatMap(h => (h.lines || []).map(l => ({ ...l, who: h.name })));
  const sit = lines.filter(l => !OUT.test(l.type || "") && l.units > 0 && l.amount > 0);
  const out = lines.filter(l => OUT.test(l.type || ""));
  const gs = d.guests || [];
  const men = gs.length ? gs.filter(g => g.sex !== "女").length : d.men ?? null;
  const women = gs.length ? gs.filter(g => g.sex === "女").length : d.women ?? null;
  const pax = gs.length || ((men || 0) + (women || 0)) || null;
  const cash = d.cash || 0, card = d.card || null;
  const mins = duration(d);
  return {
    id: row.id, chat_id: row.chat_id, status: row.status, created: row.created,
    store: normStore(d.store), rawStore: d.store || "", date: d.date || "", bill_no: d.bill_no || "", owner: d.owner || "",
    men, women, pax, cash, card, cardPct: card && cash ? Math.round((card / cash - 1) * 1000) / 10 : null,
    hostessCount: (d.hostess || []).length, hostessTotal: (d.hostess || []).reduce((a, h) => a + (h.amount || 0), 0),
    units: lines.reduce((a, l) => a + (l.units || 0), 0), unitPrice: Math.round(median(sit.map(l => l.amount / l.units))),
    outUnits: out.reduce((a, l) => a + (l.units || 0), 0), outAmount: out.reduce((a, l) => a + (l.amount || 0), 0),
    room: sum("room"), table: sum("table"), tip: sum("tip"), manager: sum("manager"), head: sum("head"), drink: sum("drink"), food: sum("food"), ride: sum("ride"), other: sum("other") + sum("diff"),
    drinks: (d.shared || []).filter(s => itemKind(s) === "drink").map(s => ({ name: s.name, qty: s.qty, price: s.price })),
    perPerson: pax ? Math.round(cash / pax) : null, minutes: mins, payers: res ? res.payers.length : 0,
  };
}

/* 同一張單可能在好幾個群組拆過：每張單（店＋單號）只留最新、已結算優先的那筆 */
export function dedupe(rows) {
  const best = new Map();
  for (const r of rows) {
    const f = facts(r);
    const k = f.bill_no ? f.store + "|" + f.bill_no.replace(/\s/g, "") : "id|" + f.id;
    const o = best.get(k);
    if (!o || (f.status === "done") > (o.status === "done") || ((f.status === "done") === (o.status === "done") && f.created > o.created)) best.set(k, { ...f, copies: (o?.copies || 0) + 1, owner: f.owner || o?.owner || "" });
    else { o.copies++; if (!o.owner && f.owner) o.owner = f.owner; }
  }
  return [...best.values()].sort((a, b) => b.created - a.created);
}

/* 各店行情：張數、平均每人、每節價（中位數）、包廂、桌面、刷卡加成 */
export function byStore(list) {
  const m = new Map();
  for (const f of list) { if (!m.has(f.store)) m.set(f.store, []); m.get(f.store).push(f); }
  return [...m.entries()].map(([store, fs]) => ({
    store, n: fs.length, cash: Math.round(fs.reduce((a, f) => a + f.cash, 0) / fs.length),
    perPerson: Math.round(median(fs.map(f => f.perPerson || 0))), unitPrice: Math.round(median(fs.map(f => f.unitPrice))),
    room: Math.round(median(fs.map(f => f.room))), table: Math.round(median(fs.map(f => f.table))),
    cardPct: median(fs.map(f => f.cardPct || 0)), minutes: Math.round(median(fs.map(f => f.minutes || 0))), last: fs[0].date,
  })).sort((a, b) => b.n - a.n);
}

/* ---------- 消費範例卡：真實帳單，人名換假名 ---------- */
const FAKE_M = ["王小明", "陳大華", "林志明", "張家豪", "李建宏", "黃俊傑", "吳冠宇", "劉育誠", "蔡承恩", "楊子賢", "許文彬", "鄭凱文"];
const FAKE_F = ["林小美", "陳怡君", "張雅婷", "李佳穎"];
const FAKE_H = ["小美", "小雅", "小琪", "小婷", "小萱", "小晴", "小薇", "小涵", "小安", "小柔", "小蓁", "小妍", "小喬", "小語", "小恩", "小倩"];
export function fakeNames(d) {
  const map = {}; let m = 0, f = 0;
  for (const g of d.guests || []) map["g:" + g.id] = g.sex === "女" ? FAKE_F[f++ % FAKE_F.length] : FAKE_M[m++ % FAKE_M.length];
  (d.hostess || []).forEach((h, i) => { map["h:" + h.name] = FAKE_H[i % FAKE_H.length]; });
  return map;
}
const row = (k, v, o = {}) => ({ type: "box", layout: "horizontal", contents: [
  { type: "text", text: k, size: o.size || "xs", color: o.kc || C.sub, flex: 7, wrap: true, ...(o.bold ? { weight: "bold" } : {}) },
  { type: "text", text: v, size: o.size || "xs", color: o.vc || C.ink, align: "end", flex: 4, ...(o.bold ? { weight: "bold" } : {}) }] });

export function sampleCard(r) {
  const d = typeof r.data === "string" ? JSON.parse(r.data || "{}") : r.data || r.d || {};
  const res = r.result ? (typeof r.result === "string" ? JSON.parse(r.result) : r.result) : null;
  const f = facts({ ...r, data: d, result: res }), fk = fakeNames(d);
  const paxText = f.pax ? `${f.pax} 人` + (f.men != null && f.women ? `（${f.men} 男 ${f.women} 女）` : "") : "";
  const sub = [f.rawStore || f.store, f.date, paxText, durText(f.minutes)].filter(Boolean).join("｜");
  const shared = (d.shared || []).filter(s => !/差額/.test(s.name)).map(s => row(s.qty > 1 ? `${s.name}（${fmt(s.price)}×${s.qty}）` : s.name, fmt(s.amount)));
  const hs = (d.hostess || []).map(h => row(`${fk["h:" + h.name]}　${h.lines.map(l => [l.type, l.units ? l.units + "節" : ""].filter(Boolean).join(" ")).join("、")}`, fmt(h.amount)));
  const payers = res ? res.payers.map(p => {
    const g = (d.guests || []).find(x => x.id === p.id);
    const inc = p.includes.length ? `（含 ${p.includes.map(x => fk["g:" + ((d.guests || []).find(g2 => g2.name === x.name)?.id)] || "同行").join("、")}）` : "";
    return row((g ? fk["g:" + g.id] : "客人") + inc, "$" + fmt(p.total), { size: "sm", kc: C.ink, vc: C.brand, bold: true });
  }) : [];
  const sep = { type: "separator", margin: "md", color: C.line };
  const title = t => ({ type: "text", text: t, size: "xs", color: C.brand, weight: "bold", margin: "md" });
  return { type: "flex", altText: `消費範例：${f.rawStore || f.store} ${paxText} 現金 $${fmt(f.cash)}`, contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "16px", contents: [
      { type: "text", text: "消費範例（真實帳單，人名為假名）", color: "#CFE3E1", size: "xxs" },
      { type: "text", text: sub, color: "#FFFFFF", weight: "bold", size: "md", wrap: true, margin: "xs" },
      { type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: "現金價", color: "#CFE3E1", size: "sm", flex: 2, gravity: "bottom" },
        { type: "text", text: "$" + fmt(f.cash), color: "#FFFFFF", weight: "bold", size: "xl", align: "end", flex: 3 }] },
      ...(f.perPerson ? [{ type: "text", text: `每人約 $${fmt(f.perPerson)}` + (f.card ? `｜刷卡 $${fmt(f.card)}（+${f.cardPct}%）` : ""), color: "#CFE3E1", size: "xs", align: "end" }] : [])] },
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "xs", contents: [
      title("公費"), ...shared.slice(0, 16), sep,
      title(`小姐（${f.units} 節${f.unitPrice ? `，每節約 ${fmt(f.unitPrice)}` : ""}）`), ...hs.slice(0, 10),
      ...(payers.length ? [sep, title("怎麼拆的"), ...payers.slice(0, 8)] : [])] },
    footer: { type: "box", layout: "vertical", paddingAll: "12px", paddingTop: "0px", contents: [
      { type: "text", text: "價格依店家、時段、小姐而不同，僅供參考", size: "xxs", color: C.sub, align: "center", wrap: true }] } } };
}
