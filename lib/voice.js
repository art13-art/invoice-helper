// 拆帳喵的語氣：話少、從容、帶點神秘，偶爾俏皮。她是「買單那個人」的秘書：不收錢、不追錢。
// 同一句話同一個聊天室不會連續出現兩次（kv voice:<種類>:<聊天室> 記上一次用哪句）。
import { kv } from "./assistant.js";
import { normStore } from "./billstats.js";

export const LINES = {
  ask: ["收到啦，表單填好喊我。", "收到～表單好了喊我。", "嗯，收下了～填好喊我 😉", "收到啦～填好再叫我。"],
  merged: ["第二張也收下了～表單填好喊我。", "嗯，兩張我都看過了～填好喊我 😉"],
  card: ["好了，一塊都沒算錯 😌", "好了～一塊不差 😌", "算好了，放心 😌", "好了～零頭也分好了 😉"],
  payee: ["記得轉給 {p}～", "錢記得轉給 {p}。", "轉給 {p} 就好～"],
  fix: ["改好了～這張才算數 😌", "重算好了～以這張為準 😌"],
  redo: ["這張我算過囉～要重來嗎？", "這張之前拆過囉～要重來一次嗎？"],
  hello: ["嗨，我是拆帳喵～"],
  notBill: ["這張，我不收～", "嗯……這不是我要的 😏", "這張不歸我管喔～"],
  cap: ["今天就到這囉～明天再來 😉"],
  unread: ["這張我看不太清楚……再拍一次給我？"],
};

/* 挑一句：跟這個聊天室上一次不同 */
export async function pick(db, chatId, kind, vars = {}) {
  const list = LINES[kind] || [""], k = `voice:${kind}:${chatId}`;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && db) {
    const last = Number(await kv.get(db, k).catch(() => null));
    if (i === last) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    await kv.set(db, k, String(i)).catch(() => {});
  }
  return list[i].replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? "");
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const nth = n => (n <= 10 ? CN[n] : String(n));
const tpHour = (ms = Date.now()) => new Date(ms + 8 * 3600e3).getUTCHours();
const monthStart = (ms = Date.now()) => { const d = new Date(ms + 8 * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 8 * 3600e3; };

/* 偶爾的梗：用帳單資料說話。每一種在同一個聊天室 3 天內最多出現一次，一次只出一個。 */
export async function tease(env, db, { chatId, group, split, now = Date.now() }) {
  const d = split.d || {}, store = normStore(d.store), cool = 3 * 864e5;
  const ok = async kind => { const k = `tease:${kind}:${chatId}`, t = Number(await kv.get(db, k)) || 0; if (now - t < cool) return false; await kv.set(db, k, String(now)); return true; };
  // 深夜私訊（凌晨 3～6 點）
  if (!group && tpHour(now) >= 3 && tpHour(now) < 6 && (await ok("late"))) return "這麼晚還在算帳？早點睡。";
  // 帳單特別大
  if ((d.cash || 0) >= (Number(env.MIAO_BIG_BILL) || 150000) && (await ok("big"))) return "這張……我先不說什麼。";
  // 同一家店這個月第三次以上
  if (store !== "未知") {
    const { results } = await db.prepare("SELECT data FROM line_splits WHERE chat_id=? AND created>=? AND status!='cancelled'").bind(chatId, monthStart(now)).all();
    const n = results.filter(r => normStore(JSON.parse(r.data || "{}").store) === store).length;
    if (n >= 3 && (await ok("store"))) return `這個月第${nth(n)}次 ${d.store} 了～要不要幫你們辦會員？`;
  }
  // 熟面孔：這張的小姐 90 天內在這個聊天室的帳單上出現過
  const names = (d.hostess || []).map(h => h.name).filter(n => n && n !== "小姐");
  if (names.length) {
    const { results } = await db.prepare("SELECT data FROM line_splits WHERE chat_id=? AND id!=? AND created>=? AND status!='cancelled' ORDER BY created DESC LIMIT 60").bind(chatId, split.id, now - 90 * 864e5).all();
    const seen = new Set(results.flatMap(r => (JSON.parse(r.data || "{}").hostess || []).map(h => h.name)));
    const again = names.find(n => seen.has(n));
    if (again && (await ok("again"))) return `${again}又在你們桌上～看來很合拍。`;
  }
  return null;
}
