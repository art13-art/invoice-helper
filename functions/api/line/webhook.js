// POST /api/line/webhook — LINE 官方帳號 Webhook（群組小助理，每個人都能用）。
// 先回 200 給 LINE，再在背景處理；所有回覆都用回覆權杖（不計每月則數）。
import { verifySignature, lineClient, textMessage, say, postback } from "../../../lib/line.js";
import { chat, member, isGroup, kv, todoText, completeByText, briefSettings, KEEP_DAYS, HELP_GROUP, HELP_USER, JOIN_NOTICE } from "../../../lib/assistant.js";
import { gas, getBook, saveBook, admins, isAdmin, settlePending } from "../../../lib/books.js";

const GROUP_CHIPS = [say("/待辦"), say("/總結"), say("/說明")];
const USER_CHIPS = [say("/待辦"), say("這個月有什麼要報的"), say("我的提醒"), say("說明")];

export async function onRequestPost({ request, env, waitUntil }) {
  const body = await request.text();
  if (!(await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature"))))
    return new Response("bad signature", { status: 401 });
  let events = [];
  try { events = JSON.parse(body).events || []; } catch (e) { return new Response("bad json", { status: 400 }); }
  const origin = new URL(request.url).origin;
  const work = (async () => { for (const ev of events) { try { await handle(env, ev, origin); } catch (e) { console.log("line event error", e.stack || e.message); } } })();
  if (waitUntil) waitUntil(work); else await work;
  return new Response("ok");
}

export async function forgetChat(db, chatId) {
  for (const t of ["line_msgs", "line_members", "line_todos", "line_reminders", "line_history", "line_pending", "line_books"])
    await db.prepare(`DELETE FROM ${t} WHERE chat_id=?`).bind(chatId).run();
  await db.prepare("DELETE FROM line_kv WHERE k=?").bind("brief:" + chatId).run();
}

async function handle(env, ev, origin) {
  const db = env.DB, line = lineClient(env.LINE_CHANNEL_TOKEN);
  if (ev.webhookEventId) {
    const r = await db.prepare("INSERT OR IGNORE INTO line_events(id,ts) VALUES(?,?)").bind(ev.webhookEventId, Date.now()).run();
    if ((r.meta?.changes ?? 1) === 0) return;
  }
  const src = ev.source || {};
  const chatId = src.groupId || src.roomId || src.userId;
  const userId = src.userId;
  if (!chatId) return;
  const group = isGroup(chatId);
  const chips = group ? GROUP_CHIPS : USER_CHIPS;
  const reply = (text, quick = chips) => ev.replyToken ? line.reply(ev.replyToken, [textMessage(text, quick)]).catch(e => console.log("reply failed", e.message)) : null;

  switch (ev.type) {
    case "join": {
      const n = await line.groupName(chatId);
      if (n) await kv.set(db, "name:" + chatId, n);
      return reply(JOIN_NOTICE);
    }
    case "leave": return forgetChat(db, chatId);
    case "memberJoined": return reply(`歡迎加入！我是群組小助理，會記錄群組文字訊息 ${KEEP_DAYS} 天來做總結和待辦；不想被記錄可以輸入「/不要記錄我」。輸入「/說明」看我能做什麼。`);
    case "memberLeft":
      for (const m of ev.left?.members || []) await db.prepare("DELETE FROM line_members WHERE chat_id=? AND user_id=?").bind(chatId, m.userId).run();
      return;
    case "follow": return reply("你好！\n\n" + HELP_USER);
    case "unfollow": return;
    case "postback": {
      const d = String(ev.postback?.data || "");
      if (d === "wipe:" + chatId) { await forgetChat(db, chatId); return reply("✓ 已清除這個群組的所有紀錄、待辦和提醒。"); }
      if (d === "keep") return reply("好，紀錄保留。");
      const m = d.match(/^(ok|no):(\w+)$/);
      if (m) {
        const nm = group ? (await member(db, line, chatId, userId)).name : "你";
        return reply(await settlePending(env, db, chatId, userId, m[2], m[1] === "ok", nm));
      }
      return;
    }
    case "message": break;
    default: return;
  }

  const msg = ev.message || {};
  const who = group ? await member(db, line, chatId, userId) : { name: (await line.name(chatId, userId).catch(() => null)) || "你", optout: 0 };

  if (msg.type !== "text") {
    if (group) {
      if (msg.type === "image" && !who.optout) await record(db, chatId, userId, who.name, "［傳了一張照片］", msg.id);
      return;   // 群組裡的貼圖、照片不回應
    }
    if (msg.type === "image") return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips }, null, "（傳了一張照片）", msg.id);
    return reply(msg.type === "sticker" ? "😊 有需要直接打字問我就好。" : "這種訊息我還看不懂，可以用文字問我。");
  }

  const raw = msg.text || "";
  const self = (msg.mention?.mentionees || []).filter(m => m.isSelf);
  // 拿掉 @小助理 本身，剩下的才是要問的內容
  let text = raw;
  for (const m of [...self].sort((a, b) => b.index - a.index)) text = text.slice(0, m.index) + text.slice(m.index + m.length);
  text = text.trim();
  const named = /^(小助理|助理)[，,:：\s]/.test(text);
  if (named) text = text.replace(/^(小助理|助理)[，,:：\s]+/, "").trim();
  const command = text.startsWith("/") || text.startsWith("／") ? text.replace(/^[/／]\s*/, "") : null;
  const addressed = !group || self.length > 0 || command !== null || named;

  // 群組裡的一般訊息只記錄，不回應
  if (group && !who.optout && !(command && /^(不要記錄我|恢復記錄|清除紀錄)$/.test(command))) await record(db, chatId, userId, who.name, raw);
  if (!addressed) return;

  // ---- 快速指令（不用 AI、不計費）----
  const c = command ?? text;
  if (/^(說明|help|怎麼用|\?|？)$/i.test(c)) return reply(group ? HELP_GROUP : HELP_USER);
  if (/^待辦(清單)?$/.test(c)) return reply(await todoText(db, chatId));
  if (/^完成\s*[0-9a-f]{4}/i.test(c)) return reply(await completeByText(db, chatId, c));
  if (group && c === "不要記錄我") {
    await db.prepare("UPDATE line_members SET optout=1 WHERE chat_id=? AND user_id=?").bind(chatId, userId).run();
    await db.prepare("DELETE FROM line_msgs WHERE chat_id=? AND user_id=?").bind(chatId, userId).run();
    return reply(`好的，${who.name} 之後的訊息不會被記錄，之前的紀錄也已刪除。想恢復請輸入「/恢復記錄」。`);
  }
  if (group && c === "恢復記錄") {
    await db.prepare("UPDATE line_members SET optout=0 WHERE chat_id=? AND user_id=?").bind(chatId, userId).run();
    return reply(`好的，${who.name} 的訊息會再開始記錄。`);
  }
  if (group && c === "清除紀錄") return reply("確定要清除這個群組的所有聊天紀錄、待辦和提醒嗎？", [postback("✓ 確定清除", "wipe:" + chatId, "確定清除"), postback("✕ 保留", "keep", "保留")]);
  if (c === "不用") return reply("好的。");
  // ---- 記帳確認（打字也可以）----
  if (/^(確認|取消)(記帳)?$/.test(c)) {
    const p = await db.prepare("SELECT id FROM line_pending WHERE chat_id=? AND user_id=? AND status='open' ORDER BY created DESC LIMIT 1").bind(chatId, userId).first();
    if (p) return reply(await settlePending(env, db, chatId, userId, p.id, c.startsWith("確認"), who.name));
  }
  // ---- 管理員與記帳表 ----
  if (!group && c === "我是管理員") {
    const list = await admins(db);
    if (list.includes(userId)) return reply("你已經是管理員了。");
    if (list.length) return reply("已經有管理員了；需要的話請現有管理員在私訊輸入「/新增管理員」並轉給你代碼。");
    await kv.set(db, "admins", JSON.stringify([userId]));
    return reply("✓ 你是管理員了。可以在廠商群組輸入「/設定記帳」建立或綁定記帳表。");
  }
  if (!group && c === "新增管理員" && (await isAdmin(db, userId))) {
    const code = Math.random().toString().slice(2, 8);
    await kv.set(db, "admincode", JSON.stringify({ code, exp: Date.now() + 10 * 60e3 }));
    return reply(`請把這段話轉給要當管理員的人，請他私訊我（10 分鐘內有效）：\n/管理員代碼 ${code}`);
  }
  if (!group && /^管理員代碼\s*\d{6}$/.test(c)) {
    const want = await kv.json(db, "admincode", null), code = c.replace(/\D/g, "");
    if (!want || want.exp < Date.now() || want.code !== code) return reply("代碼不對或已過期。");
    const list = await admins(db); if (!list.includes(userId)) list.push(userId);
    await kv.set(db, "admins", JSON.stringify(list)); await kv.set(db, "admincode", "null");
    return reply("✓ 你是管理員了。");
  }
  if (group && /^記帳表$/.test(c)) {
    const b = await getBook(db, chatId);
    return reply(b ? `這個群組的記帳表：${b.name}\n${b.url}\n（要有 Google 共用權限才打得開）` : "這個群組還沒有記帳表，管理員可以輸入「/設定記帳」。");
  }
  if (group && /^(設定記帳|取消記帳)/.test(c)) {
    if (!(await isAdmin(db, userId))) return reply("只有管理員可以設定記帳表。");
    if (c === "取消記帳") { await db.prepare("DELETE FROM line_books WHERE chat_id=?").bind(chatId).run(); return reply("✓ 已取消綁定，之後不會再寫入。表格本身和裡面的資料都保留在雲端硬碟。"); }
    const url = (c.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+[^\s]*/) || [])[0];
    const tab = (c.match(/分頁[:：]?\s*(\S+)/) || [])[1];
    try {
      const old = await getBook(db, chatId);
      if (old && !url) return reply(`這個群組已經綁定「${old.name}」。\n${old.url}\n要換表格：「/設定記帳 試算表網址」；要取消：「/取消記帳」。`);
      const info = url ? await gas(env, "linkBook", url, tab || null) : await gas(env, "createBook", (await kv.get(db, "name:" + chatId)) || "廠商群組");
      await saveBook(db, chatId, info, userId);
      return reply(`✓ ${url ? "已綁定" : "已建立"}記帳表「${info.name}」（分頁：${info.tab}）\n欄位：${info.headers.join("、")}\n${info.url}\n\n大家可以說「@小助理 記帳：…」或傳單據照片後說「@小助理 記這張」。` + (url ? "" : "\n要改成廠商原本的欄位，直接改第一列的欄位名稱就好。"));
    } catch (e) { return reply("設定沒有成功：" + e.message); }
  }
  if (c === "早報") {
    const s = await briefSettings(db, chatId); s.on = !s.on;
    await kv.set(db, "brief:" + chatId, JSON.stringify(s));
    return reply(s.on ? `✓ 已開啟每日早報，每天 ${s.time} 傳報稅期限和到期待辦。想改時間可以說「@小助理 早報改 7:30」。` + (group ? "\n（群組早報會依人數計入官方帳號每月的訊息則數）" : "") : "✓ 已關閉每日早報。");
  }

  // ---- 交給 AI ----
  const ask = c === "加入待辦" ? "請把你剛剛整理出來的待辦加入待辦清單（用 add_todos），然後列出加入的項目。" : c === "總結" ? "請總結這個群組最近 24 小時的討論。" : c.startsWith("總結") ? "請總結這個群組的討論：" + c.slice(2) : text;
  if (!ask) return reply(group ? "有什麼需要幫忙的嗎？輸入「/說明」看我能做什麼。" : HELP_USER);
  return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips, rawText: raw }, ask, ask);
}

async function record(db, chatId, userId, name, text, media) {
  await db.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts,media) VALUES(?,?,?,?,?,?)").bind(chatId, userId || null, name, String(text).slice(0, 2000), Date.now(), media || null).run();
}

async function answer(ctx, text, logText, imageId) {
  const { env, db, line, ev, chatId, userId, chips } = ctx;
  const send = t => line.reply(ev.replyToken, [textMessage(t, chips)]).catch(e => console.log("reply failed", e.message));
  if (!env.ANTHROPIC_API_KEY) return send("AI 還沒設定好，目前可以用「/待辦」「/說明」。");
  if (!isGroup(chatId)) await line.loading(userId, 30);
  if (isGroup(chatId)) { const g = await kv.get(db, "name:" + chatId); ctx.chatName = g || null; ctx.book = await getBook(db, chatId); }
  let content = [{ type: "text", text }];
  if (imageId) {
    try {
      const img = await line.image(imageId);
      content = [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: "（使用者傳來一張照片，請說明內容；如果是文件或公文，整理重點和要注意的期限。）" }];
    } catch (e) { return send("照片讀取失敗，可以再傳一次嗎？"); }
  }
  let out, pending = null;
  try { const r = await chat(ctx, content, logText); out = r.text; pending = r.pending; }
  catch (e) {
    console.log("chat error", e.message);
    out = e.status === 401 ? "AI 金鑰不正確，請管理員檢查設定。" : e.status === 429 || e.status === 529 ? "AI 現在比較忙，請過一分鐘再試。" : "我這邊出了點問題，請稍後再試一次。";
  }
  const quick = pending ? [postback(pending.label, "ok:" + pending.id, "確認"), postback("✕ 取消", "no:" + pending.id, "取消")] : /(要不要|需要).{0,12}待辦.{0,8}(加入|放進|清單)|(加入|放進)待辦清單[嗎？?]/.test(out) ? [say("/加入待辦"), say("/不用")] : chips;
  await line.reply(ev.replyToken, [textMessage(out, quick)]).catch(async e => {
    console.log("reply failed, pushing", e.message);
    await line.push(chatId, [textMessage(out, quick)]).catch(() => null);
  });
}
