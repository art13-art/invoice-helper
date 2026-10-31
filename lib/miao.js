// 拆帳喵（LINE @366dzslm）：跟小幫手共用同一套程式和資料，但只做拆帳。
// 規則：任何人都能拉進群組、都能私訊；不聊天、不記錄群組訊息、不跑小幫手的其他功能。
// 防暴衝：每個聊天室每天最多讀 MIAO_DAILY_BILLS（預設 20）張帳單、判斷 MIAO_DAILY_SCANS（預設 300）張照片。
import { lineClient, textMessage, say } from "./line.js";
import { kv, ymd, isGroup } from "./assistant.js";
import { isAdmin } from "./books.js";
import { budgetLeft } from "./audio.js";
import { recordPush } from "./usage.js";
import { normStore, facts, sampleCard } from "./billstats.js";
import { setOwner } from "../functions/bo/index.js";
import { splitMode, looksLikeBill, startSplit, askMessages, openSplit, splitPostback, splitToken, formLink, sameBill, redoMessages, replyCard } from "./split.js";

export const MIAO = "miao";
const NAME_RE = /[@＠]\s?拆帳喵/g;
export const HELP = "我是拆帳喵，專門幫應酬拆帳：\n1. 在群組貼上帳單照片\n2. 按「填寫拆帳表單」，填誰點了誰、公費怎麼分\n3. 送出後回聊天室按「貼出請款單」，每個人該付多少一目了然\n\n其他：說「請款單」再貼一次請款單；說「拆帳紀錄」看這裡拆過的帳。";
const JOIN = "大家好，我是拆帳喵 🐾\n之後在這裡貼帳單照片，我會附上拆帳表單；填完就能貼出每個人的請款單。\n不想讓我看照片，@拆帳喵 說「關閉拆帳」就好。";

export const miaoLine = env => env.MIAO_CHANNEL_TOKEN ? lineClient(env.MIAO_CHANNEL_TOKEN) : null;
const today = () => ymd(Date.now());
/* 台北時間今天 0 點（毫秒） */
const dayStart = () => Date.parse(today() + "T00:00:00+08:00");

/* 今天這個聊天室還能讀幾張帳單 */
export async function billsLeft(env, db, chatId) {
  const cap = Number(env.MIAO_DAILY_BILLS) || 20;
  const n = (await db.prepare("SELECT COUNT(*) n FROM line_splits WHERE chat_id=? AND created>=?").bind(chatId, dayStart()).first())?.n || 0;
  return cap - n;
}
/* 照片判斷次數（便宜，但防有人狂傳照片）：超過上限回 false */
async function scanOk(env, db, chatId) {
  const cap = Number(env.MIAO_DAILY_SCANS) || 300, k = `miao:scan:${chatId}:${today()}`;
  const n = Number(await kv.get(db, k)) || 0;
  if (n >= cap) return false;
  await kv.set(db, k, String(n + 1));
  return true;
}

export async function handleMiao(env, ev, origin) {
  const db = env.DB, line = miaoLine(env);
  if (!line) return;
  if (ev.webhookEventId) {
    const r = await db.prepare("INSERT OR IGNORE INTO line_events(id,ts) VALUES(?,?)").bind(ev.webhookEventId, Date.now()).run();
    if ((r.meta?.changes ?? 1) === 0) return;
  }
  const src = ev.source || {}, chatId = src.groupId || src.roomId || src.userId, userId = src.userId;
  if (!chatId) return;
  const group = isGroup(chatId);
  const send = msgs => ev.replyToken ? line.reply(ev.replyToken, msgs).catch(e => console.log("miao reply failed", e.message)) : null;
  const reply = (text, quick) => send([textMessage(text, quick)]);

  switch (ev.type) {
    case "join": {
      await kv.set(db, "miao:in:" + chatId, "1");   // 小幫手也在同一個群組時，帳單交給拆帳喵，免得兩邊都回
      const n = await line.groupName(chatId);
      if (n) await kv.set(db, "name:" + chatId, n);
      return reply(JOIN);
    }
    case "leave": return db.prepare("DELETE FROM line_kv WHERE k=?").bind("miao:in:" + chatId).run();
    case "follow": return reply("嗨，我是拆帳喵 🐾\n" + HELP);
    case "postback": {
      const d = String(ev.postback?.data || "");
      if (!d.startsWith("sp:")) return;
      const out = await splitPostback(env, db, { chatId, userId, data: d, isAdmin: await isAdmin(db, userId), origin });
      return out ? send(out) : null;
    }
    case "message": break;
    default: return;
  }

  const msg = ev.message || {};
  if (msg.type === "image") {
    if (group && (await splitMode(db, chatId)) === "off") return;
    if (!env.ANTHROPIC_API_KEY || !(await budgetLeft(env, db)) || !(await scanOk(env, db, chatId))) return;
    try {
      const img = await line.content(msg.id, 4.5 * 1024 * 1024);
      const hit = await looksLikeBill(env, db, chatId, img, true);
      if (!hit) return group ? null : reply("這張看起來不是有小姐代支的酒店帳單。拆帳喵目前只拆這種帳單喔。");
      if (!group) await line.loading(userId, 60).catch(() => {});
      return bill(env, db, line, ev, chatId, userId, [img], hit.bill_no, origin);
    } catch (e) { console.log("miao bill check", e.message); }
    return;
  }
  if (msg.type !== "text") return group ? null : reply("傳帳單照片給我就能拆帳。\n\n" + HELP);

  // 拿掉 @拆帳喵（真的 @ 或打字的），剩下的才是指令
  const self = (msg.mention?.mentionees || []).filter(m => m.isSelf);
  let text = msg.text || "";
  for (const m of [...self].sort((a, b) => b.index - a.index)) text = text.slice(0, m.index) + text.slice(m.index + m.length);
  const typedAt = /[@＠]\s?拆帳喵/.test(text);
  text = text.replace(NAME_RE, "").trim();
  const addressed = !group || self.length > 0 || typedAt;
  const c = text.replace(/^[/／]\s*/, "").replace(/賬/g, "帳").replace(/单/g, "單").replace(/[。！!～~\s]+$/g, "").replace(/^(請(?!款)|幫我|麻煩)/, "");

  // 不用 @ 也會回的：請款單、拆帳紀錄（大家在群組裡會直接這樣說）
  if (/^(貼出)?(請款單|請款卡)$/.test(c)) {
    const { results } = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status='done' AND done_at>? ORDER BY done_at DESC LIMIT 5").bind(chatId, Date.now() - 7 * 864e5).all();
    const r = results.find(x => JSON.parse(x.data || "{}").cardAt === null) || results[0];
    if (!r) return reply("這裡 7 天內沒有拆好的帳單。");
    return send(await replyCard(db, { ...r, d: JSON.parse(r.data) }));
  }
  if (/^(拆帳|分帳)(紀錄|記錄|明細|網頁)$/.test(c)) return reply(`${group ? "這個群組" : "你"}的拆帳紀錄：\n${origin}/split?t=${await splitToken(db, chatId)}`);
  if (!addressed) return;

  if (/^(說明|help|怎麼用|使用說明|你會什麼|功能|\?|？)$/i.test(c) || !c) return reply(HELP);
  if (group && /^(開啟|打開|啟動|啟用|開始|開|關閉|關掉|停止|停用|取消)(自動)?(拆帳|分帳|拆單)(功能|模式)?$/.test(c)) {
    const on = !/關|停|取消/.test(c);
    await kv.set(db, "split:on:" + chatId, on ? "1" : "0");
    return reply(on ? "好，之後貼帳單照片，我會附上拆帳表單。" : "好，之後不看這裡的照片了。要拆帳時回覆帳單照片 @拆帳喵 說「拆帳」，或說「開啟拆帳」。");
  }
  // 這是 XX 的單：內部用（後台的「誰的單」），只有 Ben 能標
  const own = c.match(/^(這|這張|那張)?(單|帳單)?(是|算)\s*(.{1,12}?)\s*的(單|客人?|帳單?)$/);
  if (own && !/^(誰|什麼|哪|哪位|哪個)/.test(own[4]) && (await isAdmin(db, userId))) {
    const r = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status!='cancelled' AND created>? ORDER BY created DESC LIMIT 1").bind(chatId, Date.now() - 7 * 864e5).first();
    if (!r) return reply("這裡 7 天內沒有帳單，先貼帳單再說一次。");
    await setOwner(db, r, own[4].trim(), "Ben");
    return reply(`好，記為「${own[4].trim()}的單」。`);
  }
  // 消費範例（人名一律假名）
  const ex1 = c.match(/^(?:消費)?範例\s*(.{0,12})$/), ex2 = !ex1 && c.match(/^(.{1,12}?)\s*的?(?:消費)?範例$/), ex = ex1 || ex2;
  if (ex) {
    const want = normStore(ex[1] || "");
    const { results } = await db.prepare("SELECT id,chat_id,status,created,data,result FROM line_splits WHERE status='done' ORDER BY created DESC LIMIT 500").all();
    const all = results.map(r => ({ r, f: facts(r) })).filter(x => x.f.cash > 0).sort((a, b) => (b.f.payers > 0) - (a.f.payers > 0));
    const stores = [...new Set(all.map(x => x.f.store))].filter(x => x !== "未知");
    if (ex1 && !ex[1]) return reply(stores.length ? "要看哪一家的消費範例？" : "還沒有可以當範例的帳單。", stores.slice(0, 12).map(st => say(st + " 範例")));
    const hit = all.find(x => x.f.store === want) || (want.length >= 2 ? all.find(x => x.f.store.includes(want) || want.includes(x.f.store)) : null);
    if (hit) return send([sampleCard(hit.r)]);
    if (ex1) return reply(`還沒有「${ex[1]}」的帳單。` + (stores.length ? `目前有：${stores.slice(0, 12).join("、")}` : ""));
  }
  if (/^(拆帳|拆單|分帳|拆這張|拆一下|算一下|拆帳單|這張拆帳)$/.test(c)) {
    if (!msg.quotedMessageId) {
      const sp = await openSplit(db, chatId);
      if (sp) return send(askMessages(sp, null, false, await formLink(db, origin, chatId, sp.id)));
      return reply("先貼帳單照片，再回覆那張照片 @拆帳喵 說「拆帳」。");
    }
    if (!env.ANTHROPIC_API_KEY || !(await budgetLeft(env, db))) return reply("拆帳喵這個月休息中，請晚點再試。");
    let img;
    try { img = await line.content(msg.quotedMessageId, 4.5 * 1024 * 1024); } catch (e) { return reply("照片讀不到了，可能已經過期，再貼一次？"); }
    return bill(env, db, line, ev, chatId, userId, [img], "", origin);
  }
  return reply(HELP);
}

/* 讀帳單 → 回「如要拆單服務，請填寫表單」（同一張單重貼不重讀；超過每日上限就不讀） */
async function bill(env, db, line, ev, chatId, userId, imgs, billNo, origin) {
  const ex = await sameBill(db, chatId, billNo).catch(() => null);
  if (ex && (ex.status === "done" || Date.now() - ex.created > 15 * 60e3)) {
    const url = await formLink(db, origin, chatId, ex.id);
    return line.reply(ev.replyToken, ex.status === "done" ? redoMessages(ex, url) : askMessages(ex, null, false, url)).catch(e => console.log("miao same bill", e.message));
  }
  if ((await billsLeft(env, db, chatId)) <= 0) {
    const k = `miao:capped:${chatId}:${today()}`;
    if (await kv.get(db, k)) return;   // 一天只講一次
    await kv.set(db, k, "1");
    return line.reply(ev.replyToken, [textMessage("今天這裡拆的帳單已經到上限了，明天再貼給我喔。")]).catch(() => null);
  }
  let r;
  try { r = await startSplit(env, db, { chatId, userId, imgs, billNo, bot: MIAO }); }
  catch (e) { console.log("miao split failed", e.message); r = { error: "帳單讀取失敗，等一下再試一次。" }; }
  const msgs = r.error ? [textMessage(r.error)] : askMessages(r.split, null, r.merged, await formLink(db, origin, chatId, r.split.id));
  await line.reply(ev.replyToken, msgs).catch(async e => {
    console.log("miao bill reply failed, pushing", e.message);
    await line.push(chatId, msgs).then(() => recordPush(db, chatId, 1)).catch(e2 => console.log("miao bill push failed", e2.message));
  });
}
