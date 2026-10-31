// 拆帳喵的語氣：話少、從容、帶點神秘，偶爾俏皮。她是「買單那個人」的秘書：不收錢、不追錢。
// 同一句話同一個聊天室不會連續出現兩次（kv voice:<種類>:<聊天室> 記上一次用哪句）。
import { kv } from "./assistant.js";
import { normStore, itemKind, duration } from "./billstats.js";

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

/* 偶爾的梗：每一種都有好幾句輪流（同一句不連續） */
Object.assign(LINES, {
  t_late: ["這麼晚還在算帳？早點睡。", "天都快亮了……還醒著？", "這個時間找我，嗯？", "先睡吧～帳又不會跑。"],
  t_first: ["第一張，我會好好算的～", "第一次交給我？放心 😌"],
  t_big: ["這張……我先不說什麼。", "嗯……我數了兩次零。", "這張，我會小心算的。", "看到總額，我也安靜了一下。"],
  t_small: ["這張……那晚很克制喔？", "今天這張，很乖嘛～"],
  t_bottle: ["{drink}……有眼光。", "那瓶{drink}，我記住了 😏", "開{drink}的那位，品味不錯喔。"],
  t_many: ["{n}位小姐……這桌很熱鬧喔。", "{n}位？難怪帳單這麼長～", "{n}位小姐，我一個一個算給你們。"],
  t_long: ["坐了{h}個多小時……體力真好。", "{h}個多小時，聊得很開心吧。", "{h}個多小時……我都替你們累了 😌"],
  t_store: ["這個月第{n}次{store}了～要不要幫你們辦會員？", "{store}這個月第{n}次了～店家應該認得你們了吧。", "又是{store}？你們真專一。", "{store}第{n}次了……我開始好奇那邊有什麼了 😏"],
  t_again: ["{name}又在你們桌上～看來很合拍。", "{name}，又是她～", "{name}又來了？我記得她喔 😏", "嗯，{name}……老面孔了。"],
});

/* 一次最多出一個梗；同一種在同一個聊天室 3 天內最多一次，任何梗之間至少隔 6 小時（才會是「偶爾」） */
export async function tease(env, db, { chatId, group, split, now = Date.now() }) {
  const d = split.d || {}, store = normStore(d.store);
  const gk = `tease:any:${chatId}`;
  if (now - (Number(await kv.get(db, gk)) || 0) < (env.MIAO_TEASE_GAP_H !== undefined ? Number(env.MIAO_TEASE_GAP_H) : 6) * 3600e3) return null;
  const ok = async kind => now - (Number(await kv.get(db, `tease:${kind}:${chatId}`)) || 0) >= 3 * 864e5;
  const say = async (kind, vars) => { const t = now + ""; await kv.set(db, `tease:${kind}:${chatId}`, t); await kv.set(db, gk, t); return pick(db, chatId, "t_" + kind, vars); };

  const prev = await db.prepare("SELECT data FROM line_splits WHERE chat_id=? AND id!=? AND created>=? AND status!='cancelled' ORDER BY created DESC LIMIT 60").bind(chatId, split.id, now - 90 * 864e5).all();
  const rows = prev.results.map(r => JSON.parse(r.data || "{}"));
  const cash = d.cash || 0, hs = (d.hostess || []).filter(h => h.name && h.name !== "小姐");
  const bottle = (d.shared || []).filter(x => itemKind(x) === "drink" && (x.price || x.amount) >= (Number(env.MIAO_FANCY_BOTTLE) || 8000)).sort((a, b) => (b.price || b.amount) - (a.price || a.amount))[0];
  const mins = duration(d) || 0;

  if (!group && tpHour(now) >= 3 && tpHour(now) < 6 && (await ok("late"))) return say("late");
  if (!rows.length && (await kv.get(db, `tease:first:${chatId}`)) === null) return say("first");
  if (cash >= (Number(env.MIAO_BIG_BILL) || 150000) && (await ok("big"))) return say("big");
  if (cash > 0 && cash <= 15000 && hs.length && (await ok("small"))) return say("small");
  if (bottle && (await ok("bottle"))) return say("bottle", { drink: String(bottle.name).replace(/\s+/g, "").slice(0, 12) });
  if (hs.length >= 8 && (await ok("many"))) return say("many", { n: nth(hs.length) });
  if (mins >= 300 && (await ok("long"))) return say("long", { h: nth(Math.floor(mins / 60)) });
  if (store !== "未知") {
    const month = (await db.prepare("SELECT data FROM line_splits WHERE chat_id=? AND created>=? AND status!='cancelled'").bind(chatId, monthStart(now)).all()).results.filter(r => normStore(JSON.parse(r.data || "{}").store) === store).length;
    if (month >= 3 && (await ok("store"))) return say("store", { n: nth(month), store: d.store });
  }
  const seen = new Set(rows.flatMap(x => (x.hostess || []).map(h => h.name)));
  const again = hs.find(h => seen.has(h.name));
  if (again && (await ok("again"))) return say("again", { name: again.name });
  return null;
}
