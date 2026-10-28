// POST /api/line/webhook — LINE 官方帳號 Webhook（群組小助理，每個人都能用）。
// 先回 200 給 LINE，再在背景處理；所有回覆都用回覆權杖（不計每月則數）。
import { vendorReply } from "../../../lib/orders.js";
import { toBlocks } from "../../../lib/files.js";
import { verifySignature, lineClient, textMessage, say, postback, meetingCard, docCard, groupPicker, helpCard } from "../../../lib/line.js";
import { watchCommit, settleCommit } from "../../../lib/commit.js";
import { splitOn, looksLikeBill, startSplit, askMessages, openSplit, parseGuests, setGuests, pickMessages, splitPostback, splitToken } from "../../../lib/split.js";
import { chat, member, isGroup, kv, when, applyGroupPick, todoText, completeByText, KEEP_DAYS, HELP_GROUP, HELP_USER, JOIN_NOTICE } from "../../../lib/assistant.js";
import { gas, getBook, saveBook, admins, isAdmin, settlePending } from "../../../lib/books.js";
import { buildReport, reportText, recordPush } from "../../../lib/usage.js";
import { adminFor, decisionCard, newDecision, toAdmin, watchAdmin } from "../../../lib/escalate.js";
import { isAudioName, transcribe, saveTranscript, recordTranscribe, budgetLeft, findTranscripts, MAX_AUDIO } from "../../../lib/audio.js";

const AUDIO_ASK = "（請整理這段錄音。第一行寫「1. 重點」，下面先一句話說這是什麼會議或在談什麼，再條列重點；有決定、待辦（誰／做什麼／何時）就在重點裡標明，沒有就省略。明確的待辦（有人、有事）直接用 add_todos 加入。有適合提醒的時間點（會議、截止日）就在最後一行寫「可提醒：」列出建議的時間和事項，但不要問要不要設。不要寫「2. 逐字稿」「3. 是否需要提醒」，也不要貼逐字稿或連結：這兩項系統會用卡片和按鈕附在下面。）";
const VIDEO_ASK = "（使用者傳來一支影片。上面附了影片封面（第一個畫面）和語音逐字稿；你看不到中間的畫面，回答時要說清楚是根據封面和聲音判斷的。先說影片在講什麼；如果是廣告或宣傳影片，評估開頭三秒的吸引力、主要訊息、CTA，給具體的改進建議。）";
const REMIND_ASK = "（使用者在會議錄音整理的卡片上按了「要，設提醒」。依你剛剛那則整理裡「可提醒」的建議設好提醒：會議照開會提醒的規則（前一天 18:00 請大家先提出要討論的事項＋會議前 30 分鐘，都用 set_reminder、auto=true）；有人要完成的事（截止日）用 add_todos 加成待辦，系統會自動在前一天和到期時提醒，對話紀錄裡已經加過的待辦不要重複加；已經過了的時間跳過。設完用「時間＋內容」簡短列出。沒有可提醒的事就直接說沒有，問他要提醒什麼。）";

const DM_CLOSED = "小幫手目前只在工作群組裡使用，私訊不開放。有事請在群組裡 @小幫手。";
const GROUP_CHIPS = [];
const USER_CHIPS = [];

export async function onRequestPost({ request, env, waitUntil }) {
  const body = await request.text();
  if (!(await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature"))))
    return new Response("bad signature", { status: 401 });
  let events = [];
  try { events = JSON.parse(body).events || []; } catch (e) { return new Response("bad json", { status: 400 }); }
  const origin = new URL(request.url).origin;
  // 有排隊服務（Cloudflare Queues）時：先排隊、立刻回 LINE；排隊服務再把同一包（含 LINE 簽章）送回來，
  // 這時連線會一直開著，可以慢慢想（最多 15 分鐘），不受「回覆後只剩 30 秒」的限制。
  const fromQueue = request.headers.get("x-from-queue") === "1";
  if (!fromQueue && env.JOBS && events.length) {
    try { await env.JOBS.send({ body, sig: request.headers.get("x-line-signature") }); return new Response("queued"); }
    catch (e) { console.log("queue send failed, handling inline", e.message); }
  }
  const runEnv = fromQueue ? { ...env, LONG_RUN: "1" } : env;
  const work = (async () => { for (const ev of events) { try { await handle(runEnv, ev, origin); } catch (e) { console.log("line event error", e.stack || e.message); } } })();
  if (fromQueue || !waitUntil) await work; else waitUntil(work);
  return new Response("ok");
}

export async function forgetChat(db, chatId) {
  for (const t of ["line_msgs", "line_members", "line_todos", "line_reminders", "line_history", "line_pending", "line_books", "line_digests"])
    await db.prepare(`DELETE FROM ${t} WHERE chat_id=?`).bind(chatId).run();
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
      // 只有 Ben（管理員）在的群組才留下：LINE 不會告訴我們是誰邀請的，所以看管理員在不在群組裡
      const adms = await admins(db);
      let inside = !adms.length;
      for (const a of adms) { if (inside) break; for (let i = 0; i < 2 && !inside; i++) inside = (await line.isMember(chatId, a)) === true; }
      if (!inside) {
        console.log("join refused: admin not in", chatId);
        if (ev.replyToken) await line.reply(ev.replyToken, [textMessage("小幫手目前只在指定的工作群組使用，先離開了。")]).catch(() => null);
        await (chatId.startsWith("R") ? line.leaveRoom(chatId) : line.leaveGroup(chatId));
        return forgetChat(db, chatId);
      }
      const n = await line.groupName(chatId);
      if (n) await kv.set(db, "name:" + chatId, n);
      return ev.replyToken ? line.reply(ev.replyToken, [helpCard(true, { keepDays: KEEP_DAYS, join: true })]).catch(e => { console.log("join card failed", e.message); return reply(JOIN_NOTICE); }) : null;
    }
    case "leave": return forgetChat(db, chatId);
    case "memberJoined": return reply(`歡迎！我是小幫手，有事 @小幫手 就好，說「說明」可以看我會做什麼。群組討論我會記 ${KEEP_DAYS} 天，不想被記錄跟我說「不要記錄我」。`);
    case "memberLeft":
      for (const m of ev.left?.members || []) await db.prepare("DELETE FROM line_members WHERE chat_id=? AND user_id=?").bind(chatId, m.userId).run();
      return;
    case "follow":
      // 只有管理員能用私訊；其他人加了好友也只回一句（LINE 沒辦法禁止別人加好友）
      if (!(await isAdmin(db, userId)) && (await admins(db)).length) return reply(DM_CLOSED, []);
      return ev.replyToken ? line.reply(ev.replyToken, [helpCard(false, { join: true })]).catch(() => reply("嗨，我是小幫手。" + HELP_USER)) : null;
    case "unfollow": return;
    case "postback": {
      const d = String(ev.postback?.data || "");
      if (!group && !/^cm:/.test(d) && !(await isAdmin(db, userId)) && (await admins(db)).length) return;   // 私訊只給管理員
      if (group) await watchAdmin(env, db, { chatId, userId, name: "", text: "" }).catch(() => null);
      if (d === "wipe:" + chatId) { await forgetChat(db, chatId); return reply("好，這個群組的紀錄、待辦和提醒都清掉了。"); }
      if (d === "keep") return reply("好，不清。");
      const gp = d.match(/^grp:(\w+):([CR]\w+)$/);
      if (gp) return reply(await applyGroupPick(env, db, { pid: gp[1], groupId: gp[2], userId, isAdmin: await isAdmin(db, userId) }));
      const ad = d.match(/^adm:(ok|all|no):(\w+)$/);
      if (ad) return reply(await adminDecision(env, db, line, chatId, userId, ad[2], ad[1]));
      const tr = d.match(/^txr:(yes|no):(\w+)$/);
      if (tr) return remindButton(env, db, line, ev, chatId, userId, tr[2], tr[1] === "yes", origin, chips, reply);
      if (d.startsWith("sp:")) {
        const out = await splitPostback(env, db, { chatId, userId, data: d, isAdmin: await isAdmin(db, userId), origin });
        return out && ev.replyToken ? line.reply(ev.replyToken, out).catch(e => console.log("split reply failed", e.message)) : null;
      }
      const cm = d.match(/^cm:(yes|no):(\w+)$/);
      if (cm) return reply(await settleCommit(db, { id: cm[2], userId, yes: cm[1] === "yes" }));
      const dn = d.match(/^done:([0-9a-f]{4})$/);
      if (dn) return reply(await doneByButton(db, line, chatId, userId, dn[1]));
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
  // 私訊只給管理員：其他人只能用「管理員代碼」（新增管理員用），其餘一律回一句
  if (!group && (await admins(db)).length && !(await isAdmin(db, userId)) && !(msg.type === "text" && /^管理員代碼\s*\d{6}$/.test((msg.text || "").trim()))) return reply(DM_CLOSED, []);
  const who = group ? await member(db, line, chatId, userId) : { name: (await line.name(chatId, userId).catch(() => null)) || "你", optout: 0 };
  // 有人找管理員：3 小時沒回就再 @ 他一次（管理員自己在群組說話就算回了）
  if (group) await watchAdmin(env, db, { chatId, userId, name: who.name, text: msg.type === "text" ? msg.text : "", mentionees: msg.mention?.mentionees }).catch(e => console.log("watchAdmin", e.message));

  if (msg.type !== "text") {
    const audio = msg.type === "audio" || (msg.type === "file" && isAudioName(msg.fileName));
    const video = msg.type === "video" || (msg.type === "file" && /\.(mp4|mov|m4v|webm)$/i.test(msg.fileName || ""));
    if (group) {
      // 錄音只記下來不自動轉（要轉：回覆那段錄音 @我，或說「整理剛剛的錄音」），免得每則語音都花錢
      if (video && !who.optout) await record(db, chatId, userId, who.name, `［傳了影片${msg.duration ? "，約 " + Math.max(1, Math.round(msg.duration / 60e3)) + " 分鐘" : ""}${msg.fileName ? "：" + msg.fileName : ""}］`, "video:" + msg.id);
      else if (audio && !who.optout) await record(db, chatId, userId, who.name, `［傳了錄音${msg.duration ? "，約 " + Math.max(1, Math.round(msg.duration / 60e3)) + " 分鐘" : ""}${msg.fileName ? "：" + msg.fileName : ""}］`, "audio:" + msg.id);
      else if (msg.type === "image" && !who.optout) await record(db, chatId, userId, who.name, "［傳了一張照片］", msg.id);
      // 開了拆帳的群組：照片先讓便宜的 AI 看是不是帳單，是就開始拆帳
      if (msg.type === "image" && (await splitOn(db, chatId)) && env.ANTHROPIC_API_KEY && (await budgetLeft(env, db))) {
        try {
          const img = await line.content(msg.id, 4.5 * 1024 * 1024);
          const hit = await looksLikeBill(env, db, chatId, img);
          if (hit) return billReply(env, db, line, ev, chatId, userId, [img], hit.bill_no);
        } catch (e) { console.log("bill check", e.message); }
      }
      else if (msg.type === "file" && !who.optout) await record(db, chatId, userId, who.name, `［傳了檔案：${msg.fileName || "檔案"}］`, "file:" + msg.id);
      return;   // 群組裡的貼圖、照片、錄音不回應
    }
    if (video) return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips }, VIDEO_ASK, "（傳了影片）", { id: msg.id, name: msg.fileName || "", video: true, duration: msg.duration, file: msg.type === "file" });
    if (audio) return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips }, AUDIO_ASK, "（傳了錄音）", { id: msg.id, name: msg.fileName || "", audio: true, duration: msg.duration });
    if (msg.type === "image") return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips }, "（使用者傳來一張照片，請說明內容；如果是文件或公文，整理重點和要注意的期限。）", "（傳了一張照片）", { id: msg.id, name: "照片.jpg" });
    if (msg.type === "file") return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips }, `（使用者傳來檔案「${msg.fileName}」，整理重點；如果有期限、金額或要處理的事，列出來。）`, `（傳了檔案：${msg.fileName}）`, { id: msg.id, name: msg.fileName || "" });
    return reply(msg.type === "sticker" ? "👍" : "這個我還看不懂，打字跟我說吧。");
  }

  const raw = msg.text || "";
  const self = (msg.mention?.mentionees || []).filter(m => m.isSelf);
  // 拿掉 @小助理 本身，剩下的才是要問的內容
  let text = raw;
  for (const m of [...self].sort((a, b) => b.index - a.index)) text = text.slice(0, m.index) + text.slice(m.index + m.length);
  // 電腦版 LINE 常常 @ 不到官方帳號：打字寫「@小幫手」也算在叫它（真正的 @ 已經在上面拿掉了）
  const typedAt = /[@＠]\s?小幫手/.test(text);
  if (typedAt) text = text.replace(/[@＠]\s?小幫手/g, "");
  text = text.trim();
  const command = text.startsWith("/") || text.startsWith("／") ? text.replace(/^[/／]\s*/, "") : null;
  const addressed = !group || self.length > 0 || typedAt || command !== null;   // 群組裡只有 @小幫手 或按鈕送出的「/」指令才回應

  // 群組裡的一般訊息只記錄，不回應
  if (group && !who.optout && !(command && /^(不要記錄我|恢復記錄|清除紀錄)$/.test(command))) await record(db, chatId, userId, who.name, raw);
  if (group) await vendorReply(env, db, line, chatId, userId, who.name, text).catch(e => console.log("vendor reply", e.message));
  // 沒叫小幫手、但說了自己要做的事（「我明天交報價」）：私訊問他要不要加成待辦
  if (group && !addressed && !who.optout) await watchCommit(env, db, line, { chatId, userId, name: who.name, text: raw, replyToken: ev.replyToken, chatName: await kv.get(db, "name:" + chatId) }).catch(e => console.log("watchCommit", e.message));
  if (!addressed) return;

  // ---- 快速指令（不用 AI、不計費）----
  const c = command ?? text;
  if (/^(說明|help|怎麼用|使用說明|你會什麼|你會做什麼|功能|\?|？)$/i.test(c))
    return ev.replyToken ? line.reply(ev.replyToken, [helpCard(group, { keepDays: KEEP_DAYS, split: group && (await splitOn(db, chatId)) })]).catch(() => reply(group ? HELP_GROUP : HELP_USER)) : null;
  if (/^(待辦(清單|事項)?|有哪些待辦[?？]?)$/.test(c)) return reply(await todoText(db, chatId), await todoChips(db, chatId));
  if (/^完成\s*[0-9a-f]{4}/i.test(c)) return reply(await completeByText(db, chatId, c));
  if (group && /^(請)?(不要|別|停止)(再)?(記錄|紀錄)我(的訊息)?$/.test(c)) {
    await db.prepare("UPDATE line_members SET optout=1 WHERE chat_id=? AND user_id=?").bind(chatId, userId).run();
    await db.prepare("DELETE FROM line_msgs WHERE chat_id=? AND user_id=?").bind(chatId, userId).run();
    return reply(`好，${who.name}，之後不會記錄你的訊息，之前的也刪了。要恢復跟我說一聲。`);
  }
  if (group && /^(恢復|重新)(記錄|紀錄)(我)?$/.test(c)) {
    await db.prepare("UPDATE line_members SET optout=0 WHERE chat_id=? AND user_id=?").bind(chatId, userId).run();
    return reply(`好，${who.name}，你的訊息會再開始記錄。`);
  }
  if (group && /^(清除|刪除|清空)(群組|這裡的|所有)?(聊天)?(紀錄|記錄)$/.test(c)) return reply("要清掉這個群組的聊天紀錄、待辦和提醒嗎？清了就救不回來。", [postback("清除", "wipe:" + chatId, "清除"), postback("不要", "keep", "不要")]);
  if (c === "不用") return reply("好。");
  // ---- 記帳確認（打字也可以）----
  if (/^(確認|取消)(記帳)?$/.test(c)) {
    const p = await db.prepare("SELECT id FROM line_pending WHERE chat_id=? AND user_id=? AND status='open' AND kind='rows' ORDER BY created DESC LIMIT 1").bind(chatId, userId).first();
    if (p) return reply(await settlePending(env, db, chatId, userId, p.id, c.startsWith("確認"), who.name));
  }
  // ---- 管理員：本月用量 ----
  if (!group && c.length <= 20 && /(用量|花費|開銷|費用|花了多少|花多少|帳單|token)/i.test(c) && !/記帳|報價|運費|單價/.test(c) && (await isAdmin(db, userId)))
    return reply(reportText(await buildReport(env, db, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7))).replace("開銷報表", "開銷（到目前為止）"));
  // ---- 管理員與記帳表 ----
  if (!group && c === "我是管理員") {
    const list = await admins(db);
    if (list.includes(userId)) return reply("你已經是管理員了。");
    if (list.length) return reply("已經有管理員了；需要的話請現有管理員私訊我「新增管理員」，再把代碼轉給你。");
    await kv.set(db, "admins", JSON.stringify([userId]));
    return reply("好，你是管理員了。費用快到上限、每月 1 號的開銷報表都會傳給你；想知道目前花多少直接問我。");
  }
  if (!group && c === "新增管理員" && (await isAdmin(db, userId))) {
    const code = Math.random().toString().slice(2, 8);
    await kv.set(db, "admincode", JSON.stringify({ code, exp: Date.now() + 10 * 60e3 }));
    return reply(`請把這段話轉給要當管理員的人，請他私訊我（10 分鐘內有效）：\n管理員代碼 ${code}`);
  }
  if (!group && /^管理員代碼\s*\d{6}$/.test(c)) {
    const want = await kv.json(db, "admincode", null), code = c.replace(/\D/g, "");
    if (!want || want.exp < Date.now() || want.code !== code) return reply("代碼不對或已過期。");
    const list = await admins(db); if (!list.includes(userId)) list.push(userId);
    await kv.set(db, "admins", JSON.stringify(list)); await kv.set(db, "admincode", "null");
    return reply("好，你是管理員了。");
  }
  if (group && /^(記帳表|紀錄表|記錄表)$/.test(c)) {
    const b = await getBook(db, chatId), kind = b?.type === "log" ? "紀錄表" : "記帳表";
    return reply(b ? `這個群組的${kind}：${b.name}\n${b.url}\n（要有 Google 共用權限才打得開）` : "這個群組還沒有表格，要的話 @我 說「設定紀錄表」或「設定記帳表」。");
  }
  if (group && /^(設定|取消)(記帳|紀錄|記錄)/.test(c)) {
    if (await isAdmin(db, userId)) return reply(await bookCommand(env, db, chatId, c, userId));
    // 不是管理員：直接 @管理員，附按鈕讓他決定
    const adm = await adminFor(env, db, chatId);
    const id = await newDecision(db, { chatId, userId, kind: "book", payload: { c }, summary: c });
    const kind = /紀錄|記錄/.test(c) ? "紀錄表" : "記帳表", ask = c.startsWith("取消") ? `取消這個群組的${kind}` : `幫這個群組設定${kind}`;
    const r = await toAdmin(env, db, { chatId, chatName: await kv.get(db, "name:" + chatId), adm, text: `${who.name} 想${ask}：「${c}」`, card: decisionCard(ask + "？", c, id, { yes: c.startsWith("取消") ? "取消" : "設定" }) });
    const head = textMessage(r.how === "none" ? "這個要設定的人確認，目前還沒有人能確認。" : `好，我請 ${adm.name} 確認一下。`);
    return ev.replyToken ? line.reply(ev.replyToken, [head, ...r.msgs].slice(0, 5)).catch(e => console.log("reply failed", e.message)) : null;
  }

  // ---- 拆帳 ----（「賬」「单」也算；說法放寬：啟動／開始／啟用、幫我拆帳…）
  const sc = c.replace(/賬/g, "帳").replace(/单/g, "單").replace(/[。！!～~\s]+$/g, "").replace(/^(請|幫我|麻煩)?/, "");
  if (group && /^(開啟|打開|啟動|啟用|開始|開|關閉|關掉|停止|停用|取消)(自動)?(拆帳|分帳|拆單)(功能|模式)?$/.test(sc)) {
    if (!(await isAdmin(db, userId))) return reply("拆帳設定只有 Ben 能改。");
    const on = !/關|停|取消/.test(sc);
    await kv.set(db, "split:on:" + chatId, on ? "1" : "0");
    return reply(on ? "好，這個群組開啟拆帳：之後貼帳單照片，我會自動讀，再 @Ben 問人名。" : "好，這個群組關閉自動拆帳。要拆還是可以回覆帳單照片 @我 說「拆帳」。");
  }
  if (group && /^(拆帳|分帳)(紀錄|記錄|明細|網頁)$/.test(sc)) return reply(`這個群組的拆帳紀錄：\n${origin}/split?t=${await splitToken(db, chatId)}`);
  if (group && /^(拆帳|拆單|分帳|拆這張|拆一下|算一下|拆帳單|這張拆帳)$/.test(sc)) {
    // 回覆某張照片，或抓最近 15 分鐘的照片（最多 2 張，同一張單的明細＋結帳單）
    const ids = [];
    if (msg.quotedMessageId) ids.push(msg.quotedMessageId);
    else {
      const { results } = await db.prepare("SELECT media FROM line_msgs WHERE chat_id=? AND media IS NOT NULL AND media NOT LIKE '%:%' AND ts>? ORDER BY id DESC LIMIT 2").bind(chatId, Date.now() - 15 * 60e3).all();
      ids.push(...results.map(r => r.media).reverse());
    }
    if (!ids.length) return reply("先貼帳單照片，再回覆那張照片 @我 說「拆帳」。");
    if (!(await budgetLeft(env, db))) return reply("這個月的費用已經到上限，先不讀帳單。");
    const imgs = [];
    for (const id of ids) { try { imgs.push(await line.content(id, 4.5 * 1024 * 1024)); } catch (e) { console.log("bill img", e.message); } }
    if (!imgs.length) return reply("照片讀不到了，可能已經過期，再貼一次？");
    return billReply(env, db, line, ev, chatId, userId, imgs, "");
  }
  // Ben 回答拆帳的人名
  if (group && (await isAdmin(db, userId))) {
    const sp = await openSplit(db, chatId);
    // 問人名的階段每句都看；已經在點卡片的階段，像是要改名單（有人數、男女、併）才看
    if (sp && (sp.status === "ask" || /\d+\s*(人|位)|男|女|併/.test(c))) {
      const p = await parseGuests(env, db, chatId, c).catch(e => { console.log("parse guests", e.message); return null; });
      if (p) {
        await setGuests(db, sp, p);
        const msgs = pickMessages(sp);
        if (p.count && p.count !== p.guests.length) msgs[0] = textMessage(`你說 ${p.count} 人，但我只認到 ${p.guests.length} 個名字：${p.guests.map(g => g.name).join("、")}。有漏的再回我一次完整的名單。\n\n` + msgs[0].text);
        return line.reply(ev.replyToken, msgs).catch(e => console.log("pick reply failed", e.message));
      }
    }
  }

  // ---- 交給 AI ----
  const ask = c === "詳細分析" ? "（請把你上一則回答展開成詳細分析：需要就上網多查幾個來源、補充數據、比較和具體建議；官方資料附網址；內容長就用 save_report 存成文件，LINE 裡回重點和連結。）" : c === "加入待辦" ? "請把你剛剛整理出來的待辦加入待辦清單（用 add_todos），然後列出加入的項目。" : c === "總結" ? "請總結這個群組最近 24 小時的討論。" : c.startsWith("總結") ? "請總結這個群組的討論：" + c.slice(2) : text;
  // 回覆（引用）某張照片、檔案或錄音再 @ 它：直接把那個照片／檔案／錄音一起給它
  let attach = null;
  if (msg.quotedMessageId) {
    const q = await db.prepare("SELECT text,media FROM line_msgs WHERE chat_id=? AND (media=? OR media=? OR media=? OR media=?) LIMIT 1").bind(chatId, msg.quotedMessageId, "file:" + msg.quotedMessageId, "audio:" + msg.quotedMessageId, "video:" + msg.quotedMessageId).first();
    if (q) attach = q.media.startsWith("video:") ? { id: msg.quotedMessageId, name: (q.text.match(/：(.*)］/) || [])[1] || "", video: true } : q.media.startsWith("audio:") ? { id: msg.quotedMessageId, name: (q.text.match(/：(.*)］/) || [])[1] || "", audio: true }
      : { id: msg.quotedMessageId, name: q.media.startsWith("file:") ? (q.text.match(/檔案：(.*)］/) || [])[1] || "" : "照片.jpg" };
  }
  // 「整理剛剛的錄音」「會議錄音轉文字」：沒引用時抓最近 24 小時的錄音（先找自己傳的）
  if (!attach && group && /錄音|語音/.test(c) && /整理|轉|逐字|摘要|重點|紀錄|記錄|會議/.test(c)) {
    const q = await db.prepare("SELECT text,media FROM line_msgs WHERE chat_id=? AND media LIKE 'audio:%' AND ts>? ORDER BY (user_id=?) DESC, id DESC LIMIT 1").bind(chatId, Date.now() - 864e5, userId).first();
    if (q) attach = { id: q.media.slice(6), name: (q.text.match(/：(.*)］/) || [])[1] || "", audio: true };
  }
  // 「看一下剛剛的影片」：沒引用時抓最近 24 小時的影片
  if (!attach && group && /影片|影音|短影音|video/i.test(c)) {
    const q = await db.prepare("SELECT text,media FROM line_msgs WHERE chat_id=? AND media LIKE 'video:%' AND ts>? ORDER BY (user_id=?) DESC, id DESC LIMIT 1").bind(chatId, Date.now() - 864e5, userId).first();
    if (q) attach = { id: q.media.slice(6), name: (q.text.match(/：(.*)］/) || [])[1] || "", video: true };
  }
  if (!ask && attach?.video) return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips, rawText: raw }, VIDEO_ASK, "（請看這支影片）", attach);
  if (!ask && attach) return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips, rawText: raw }, attach.audio ? AUDIO_ASK : "（看一下這個，整理重點）", attach.audio ? "（請整理這段錄音）" : "（@了小助理）", attach);
  if (!ask) {
    // 只 @ 沒說事：通常是要它處理前面剛說過的內容，交給 AI 從最近的對話判斷
    const q = `（${who.name} 只 @ 了你，沒有另外說內容。看最近的群組對話，特別是 ${who.name} 剛才說的話，判斷他要你做什麼並直接處理。只處理他最新、還沒處理過的那件事，已經處理過的（標了［已完成］）不要再做；真的看不出來才簡短問一句。）`;
    return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips, rawText: raw }, q, "（@了小助理）");
  }
  return answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips, rawText: raw }, ask, ask, attach);
}

/* 讀帳單並在群組 @Ben 問人名（讀帳單要 20～40 秒，回覆權杖過期就改推播） */
async function billReply(env, db, line, ev, chatId, userId, imgs, billNo) {
  let r;
  try { r = await startSplit(env, db, { chatId, userId, imgs, billNo }); }
  catch (e) { console.log("split failed", e.message); r = { error: "帳單讀取失敗，等一下再試一次。" }; }
  const adm = await adminFor(env, db, chatId).catch(() => null);
  const msgs = r.error ? [textMessage(r.error)] : askMessages(r.split, adm?.inChat ? adm.id : null, r.merged);
  await line.reply(ev.replyToken, msgs).catch(async e => {
    console.log("bill reply failed, pushing", e.message);
    await line.push(chatId, msgs).then(() => recordPush(db, chatId, 1)).catch(e2 => console.log("bill push failed", e2.message));
  });
}

/* 提醒卡或待辦清單上按「✓ 已完成」：負責人、交辦的人或管理員按了就劃掉，之後不再提醒 */
async function doneByButton(db, line, chatId, userId, id) {
  const t = await db.prepare("SELECT * FROM line_todos WHERE id=? AND chat_id=?").bind(id, chatId).first();
  if (!t) return "找不到這件待辦，可能已經刪掉了。";
  if (t.status !== "open") return `這件已經完成了：${t.task}`;
  if (t.assignee_id && t.assignee_id !== userId && t.created_by !== userId && !(await isAdmin(db, userId)))
    return `這件是 ${t.assignee_name || "負責人"} 的，請本人按「已完成」，或跟我說一聲。`;
  const r = await db.prepare("UPDATE line_todos SET status='done', done_at=? WHERE id=? AND status='open'").bind(Date.now(), id).run();
  if ((r.meta?.changes ?? 1) === 0) return `這件已經完成了：${t.task}`;
  await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE todo_id=? AND status='open'").bind(id).run();
  const who = isGroup(chatId) ? await member(db, line, chatId, userId) : { name: "你", optout: 0 };
  if (isGroup(chatId) && !who.optout) await record(db, chatId, userId, who.name, `［按了已完成：${t.task}］`);
  return `✓ ${isGroup(chatId) ? who.name + " " : ""}完成了：${t.task}\n之後不會再提醒這件。`;
}

/* 記帳表設定／取消（管理員本人，或管理員按了「設定」之後） */
const LOG_HEADERS = ["日期", "項目", "類型", "假設／內容", "版本", "數據", "結果", "結論", "負責人", "備註", "記錄人", "原始訊息", "記錄時間"];
async function bookCommand(env, db, chatId, c, userId) {
  const log = /紀錄|記錄/.test(c), kind = log ? "紀錄表" : "記帳表";
  if (/^取消/.test(c)) { await db.prepare("DELETE FROM line_books WHERE chat_id=?").bind(chatId).run(); return "✓ 已取消綁定，之後不會再寫入。表格本身和裡面的資料都保留在雲端硬碟。"; }
  const url = (c.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+[^\s]*/) || [])[0];
  const tab = (c.match(/分頁[:：]?\s*(\S+)/) || [])[1];
  try {
    const old = await getBook(db, chatId);
    if (old && !url) return `這個群組已經綁定「${old.name}」。\n${old.url}\n要換表格：@我 說「設定${kind}」加上試算表網址；要取消：說「取消${kind.slice(0, 2)}」。`;
    const title = (await kv.get(db, "name:" + chatId)) || "群組";
    let info, note = "";
    if (url) info = await gas(env, "linkBook", url, tab || null);
    else if (log) {
      try { info = await gas(env, "createLog", title, LOG_HEADERS); }
      catch (e) { if (!/unknown function/.test(e.message)) throw e; info = await gas(env, "createBook", title); note = "\n（Apps Script 還沒更新，先用記帳表的欄位建立；直接改第一列的欄位名稱就好）"; }
    } else info = await gas(env, "createBook", title);
    await saveBook(db, chatId, info, userId);
    await kv.set(db, "booktype:" + chatId, log ? "log" : "book");
    const how = log ? "大家可以 @我 說「記一筆：標題 A/B 測試，A 版 CTR 2.1%、B 版 1.4%，結論 A 勝」，或傳報表後 @我 說「把結果記下來」。"
      : "大家可以 @我 說「記帳：碳粉 2 盒 3,200」，或傳單據照片後 @我 說「記這張」。";
    return `✓ ${url ? "已綁定" : "已建立"}${kind}「${info.name}」（分頁：${info.tab}）\n欄位：${info.headers.join("、")}\n${info.url}\n\n${how}` + (url ? "" : "\n要改欄位，直接改第一列的欄位名稱就好。") + note;
  } catch (e) { return "設定沒有成功：" + e.message; }
}

/* 管理員在卡片上按「設定／所有群組都套用／不設定」 */
async function adminDecision(env, db, line, chatId, userId, id, act) {
  const p = await db.prepare("SELECT * FROM line_pending WHERE id=? AND kind IN ('memory','forget','book')").bind(id).first();
  if (!p) return "找不到這件事，可能已經過期了。";
  if (!(await isAdmin(db, userId))) { const adm = await adminFor(env, db, chatId); return `這個要等 ${adm?.name || "負責的人"} 決定。`; }
  if (p.status !== "open") return p.status === "done" ? "這件已經設定好了。" : "這件已經決定不設定了。";
  const lock = await db.prepare("UPDATE line_pending SET status=? WHERE id=? AND status='open'").bind(act === "no" ? "cancelled" : "done", id).run();
  if ((lock.meta?.changes ?? 1) === 0) return "這件正在處理中。";
  const pl = JSON.parse(p.payload || "{}"), asker = p.user_id ? (await member(db, line, p.chat_id, p.user_id).catch(() => null))?.name || "對方" : "對方";
  let out;
  if (act === "no") out = `好，不設定。`;
  else if (p.kind === "memory") {
    const now = Date.now(), scope = act === "all" ? null : p.chat_id;
    if (pl.replaces) await db.prepare("UPDATE line_memory SET text=?, updated=?, created_by=?, chat_id=? WHERE id=?").bind(pl.text, now, p.user_id, scope, pl.replaces).run();
    else await db.prepare("INSERT INTO line_memory(id,text,created_by,created,updated,chat_id) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID().slice(0, 4), pl.text, p.user_id, now, now, scope).run();
    out = `✓ 記住了（${scope ? "只用在這個群組" : "所有群組都套用"}）：${pl.text}`;
  } else if (p.kind === "forget") { await db.prepare("DELETE FROM line_memory WHERE id=?").bind(pl.id).run(); out = `✓ 刪掉了：${p.summary}`; }
  else out = await bookCommand(env, db, p.chat_id, pl.c, p.user_id);
  // 管理員是在私訊裡按的：也讓原本的群組知道結果
  if (p.chat_id !== chatId) {
    await line.push(p.chat_id, [textMessage(act === "no" ? `${asker} 提的「${p.summary.slice(0, 60)}」先不設定。` : out)]).then(() => recordPush(db, p.chat_id, 1)).catch(e => console.log("push failed", e.message));
  }
  return out;
}

/* 會議卡片的「要，設提醒／不用」：可以改主意。
   狀態存在 txr:<逐字稿id>：no＝不設；yes:[提醒id…]＝設了哪些。不用→要：照建議設；要→不用：把剛設的取消；同一個按兩次才說處理過了。 */
async function remindButton(env, db, line, ev, chatId, userId, txId, want, origin, chips, reply) {
  const k = "txr:" + txId, cur = (await kv.get(db, k)) || "";
  if (cur === "busy") return reply("正在設提醒，等我一下。");
  if (want ? cur.startsWith("yes") : cur === "no") return reply(want ? "提醒已經設好了。要改直接跟我說。" : "已經是不設提醒了。");
  if (!want) {
    let got = {}; try { got = JSON.parse(cur.slice(4) || "{}"); } catch (e) {}
    const ids = Array.isArray(got) ? got : got.r || [], todos = Array.isArray(got) ? [] : got.t || [];
    await kv.set(db, k, "no");
    const lines = [];
    if (ids.length) {
      const { results } = await db.prepare(`SELECT id,due,text FROM line_reminders WHERE status='open' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
      for (const r of results) { await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE id=? AND status='open'").bind(r.id).run(); lines.push(`・${when(r.due)} ${r.text}`); }
    }
    for (const id of todos) {
      const t = await db.prepare("SELECT task FROM line_todos WHERE id=? AND status='open'").bind(id).first();
      if (!t) continue;
      await db.prepare("UPDATE line_todos SET status='cancelled' WHERE id=?").bind(id).run();
      await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE todo_id=? AND status='open'").bind(id).run();
      lines.push(`・待辦：${t.task}`);
    }
    return reply(lines.length ? "好，剛剛設的提醒都取消了：\n" + lines.join("\n") : "好，不設提醒。");
  }
  await kv.set(db, k, "busy");
  const t0 = Date.now();
  const who = isGroup(chatId) ? await member(db, line, chatId, userId) : { name: "你" };
  try { await answer({ env, db, line, ev, chatId, userId, userName: who.name, origin, chips }, REMIND_ASK, "（按了：要，幫我設提醒）"); }
  finally {
    const { results } = await db.prepare("SELECT id FROM line_reminders WHERE (chat_id=? OR chat_id=?) AND created_by=? AND created>=? AND todo_id IS NULL AND status='open'").bind(chatId, userId, userId, t0).all();
    const { results: td } = await db.prepare("SELECT id FROM line_todos WHERE chat_id=? AND created_by=? AND created>=? AND status='open'").bind(chatId, userId, t0).all();
    await kv.set(db, k, "yes:" + JSON.stringify({ r: results.map(r => r.id), t: td.map(r => r.id) }));
  }
}

/* 待辦清單下面的「✓ 完成」快速按鈕（最多 10 件） */
async function todoChips(db, chatId) {
  const { results } = await db.prepare("SELECT id,task FROM line_todos WHERE chat_id=? AND status='open' ORDER BY due IS NULL, due LIMIT 10").bind(chatId).all();
  return results.map(t => postback("✓ " + t.task, "done:" + t.id, "✓ 已完成：" + String(t.task).slice(0, 40)));
}

async function record(db, chatId, userId, name, text, media) {
  await db.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts,media) VALUES(?,?,?,?,?,?)").bind(chatId, userId || null, name, String(text).slice(0, 2000), Date.now(), media || null).run();
}

async function answer(ctx, text, logText, attach) {
  const { env, db, line, ev, chatId, userId, chips } = ctx;
  const send = t => line.reply(ev.replyToken, [textMessage(t, chips)]).catch(e => console.log("reply failed", e.message));
  if (!env.ANTHROPIC_API_KEY) return send("我還在設定中，晚點再找我。");
  if (!isGroup(chatId)) await line.loading(userId, 30);
  ctx.isAdmin = await isAdmin(db, userId);
  if (isGroup(chatId)) { const g = await kv.get(db, "name:" + chatId); ctx.chatName = g || null; ctx.book = await getBook(db, chatId); }
  let content = [{ type: "text", text }], tail = "", card = null;
  if (attach?.audio) {
    // 同一段錄音轉過就直接用存好的逐字稿，不重複花錢
    const prev = (await findTranscripts(db, chatId)).find(x => x.src === attach.id);
    if (!prev && !(await budgetLeft(env, db))) return tellAdmin(ctx, "這個月的費用已經到上限，錄音先不轉。", `${ctx.userName || "有人"} 傳了錄音，但這個月的預算已經用完，沒有轉。要調高預算嗎？`);
    if (!isGroup(chatId)) await line.loading(userId, 60);
    try {
      let t, saved;
      if (prev) { t = { text: prev.text, seconds: (prev.minutes || 1) * 60, speakers: prev.speakers }; saved = prev; }
      else {
        const f = await line.content(attach.id, MAX_AUDIO);
        t = await transcribe(env, f.bytes, f.type, attach.name, { durationMs: attach.duration, timeoutMs: env.LONG_RUN === "1" ? 280e3 : 20e3 });
        await recordTranscribe(db, { chatId, userId, model: t.model, seconds: t.seconds }).catch(e => console.log("usage", e.message));
        if (!t.text) return send("這段錄音裡沒聽到說話內容。");
        saved = await saveTranscript(env, db, { chatId, chatName: ctx.chatName, userId, userName: ctx.userName, t, src: attach.id });
      }
      const min = Math.max(1, Math.round(t.seconds / 60));
      const body = t.text.length > 60000 ? t.text.slice(0, 60000) + "\n（後面太長，略）" : t.text;
      content = [{ type: "text", text: `（以下是那段錄音的逐字稿，約 ${min} 分鐘。${t.speakers ? "「說話者 A、B…」是系統自動分辨的不同人，不知道真名；對話裡聽得出名字就對應起來，聽不出就照代號寫。" : ""}）\n${body}` }, { type: "text", text }];
      tail = saved.url ? `\n\n完整逐字稿（約 ${min} 分鐘）：${saved.url}` : `\n\n（${saved.docErr || "雲端備份沒存成功"}；逐字稿我先留 ${KEEP_DAYS} 天，可以直接問我）`;
      card = meetingCard({ txId: saved.id, minutes: t.seconds / 60, speakers: t.speakers, url: saved.url });
    } catch (e) {
      if (e.admin) return tellAdmin(ctx, "錄音轉文字暫時不能用。", e.message);
      return send(/^content \d/.test(e.message) ? "錄音沒讀到，可能已經過期了，再傳一次？" : e.message);
    }
  } else if (attach?.video) {
    if (!isGroup(chatId)) await line.loading(userId, 60);
    const blocks = [];
    try { const pv = await line.preview(attach.id); blocks.push(...(await toBlocks(pv.bytes, pv.type, "封面.jpg"))); } catch (e) { console.log("video preview", e.message); }
    let heard = "（沒有取得聲音內容）";
    try {
      if (!(await budgetLeft(env, db))) heard = "（這個月預算用完，聲音沒有轉文字）";
      else {
        const f = await line.content(attach.id, MAX_AUDIO);
        const t = await transcribe(env, f.bytes, f.type || "video/mp4", /\.(mp4|webm|m4a)$/i.test(attach.name) ? attach.name : "影片.mp4", { durationMs: attach.duration, timeoutMs: env.LONG_RUN === "1" ? 280e3 : 20e3 });
        await recordTranscribe(db, { chatId, userId, model: t.model, seconds: t.seconds }).catch(e => console.log("usage", e.message));
        heard = t.text ? `語音逐字稿（約 ${Math.max(1, Math.round(t.seconds / 60))} 分鐘）：\n${t.text.slice(0, 40000)}` : "（影片裡沒有聽到說話，可能只有音樂）";
      }
    } catch (e) {
      if (e.admin) await escalateErr(ctx, e.message);
      heard = /太大/.test(e.message) ? "（影片超過 25MB，聲音沒辦法轉文字，只看得到封面）" : /^content \d/.test(e.message) ? "（影片已經過期，讀不到）" : "（聲音轉文字失敗：" + e.message + "）";
    }
    if (!blocks.length && /過期|讀不到/.test(heard)) return send("影片沒讀到，可能已經過期了，再傳一次？");
    content = [...blocks, { type: "text", text: heard }, { type: "text", text }];
  } else if (attach) {
    try {
      const f = await line.content(attach.id);
      content = [...(await toBlocks(f.bytes, f.type, attach.name)), { type: "text", text }];
    } catch (e) { return send(/讀不了|太大/.test(e.message) ? e.message : "檔案沒讀到，可能已經過期了，再傳一次？"); }
  }
  let out, pending = null;
  try { const r = await chat(ctx, content, logText); out = r.text + (card && !/雲端備份/.test(tail) ? "" : tail); pending = r.pending; }
  catch (e) {
    console.log("chat error", e.message);
    card = null;
    if (e.status === 401) { await escalateErr(ctx, "Claude 金鑰好像失效了（401），我現在回不了話。"); }
    out = (e.status === 401 ? "我這邊連線出了問題，暫時回不了。" : e.status === 429 || e.status === 529 ? "我這邊塞車了，過一分鐘再找我。" : "我這邊出了點狀況，等一下再找我一次。") + (tail ? "\n錄音已經轉好了，晚點叫我整理就好。" + tail : "");
  }
  let quick = pending ? [postback(pending.label, "ok:" + pending.id, "確認"), postback("✕ 取消", "no:" + pending.id, "取消")] : /(要不要|需要).{0,12}待辦.{0,8}(加入|放進|清單)|(加入|放進)待辦清單[嗎？?]/.test(out) ? [say("/加入待辦"), say("/不用")] : chips;
  // 一般的回答下面放「詳細分析」按鈕（按了＝請它把這則展開；已經是詳細版、確認按鈕、很短的回覆就不放）
  // 存了文件：網址從文字拿掉（放進卡片）
  const docs = (ctx.savedDocs || []).slice(0, 2);
  if (docs.length) out = out.replace(/[：:]?[ \t]*\n?[ \t]*https:\/\/docs\.google\.com\/\S+/g, "").replace(/\n{3,}/g, "\n\n").trim() || "好了。";
  if (!pending && !ctx.deep && !card && !docs.length && !ctx.groupPick && out.length > 60 && !/^(好|收到|OK)/i.test(out)) quick = [...(quick || []), { type: "message", label: "詳細分析", text: "/詳細分析" }];
  // 長回答切成最多 5 則（LINE 每則約 5,000 字上限），快速回覆按鈕放在最後一則
  const extra = [...(card ? [card] : []), ...(ctx.groupPick ? [groupPicker(ctx.groupPick.id, ctx.groupPick.groups, ctx.groupPick.best)] : []), ...docs.map(d => docCard(d.title, d.url)), ...(ctx.adminMsgs || [])].slice(0, 3);
  const parts = splitText(out, 4800).slice(0, 5 - extra.length);
  const msgs = parts.map((p, i) => textMessage(p, i === parts.length - 1 ? quick : undefined));
  msgs.push(...extra);
  await line.reply(ev.replyToken, msgs).catch(async e => {
    console.log("reply failed, pushing", e.message);
    // 回覆權杖過期 → 用推播；卡片或 @ 被拒 → 只送文字
    const plain = msgs.filter(m => m.type === "text");
    const ok = await line.reply(ev.replyToken, plain).then(() => true).catch(() => false);
    if (!ok) await line.push(chatId, msgs).catch(() => line.push(chatId, plain)).then(() => recordPush(db, chatId, 1)).catch(() => null);
  });
}

/* 出了要管理員處理的問題：在群組就 @他，不在就私訊他（同一種問題一小時只通知一次） */
async function escalateErr(ctx, adminText) {
  const { env, db, chatId } = ctx, k = "admwarn:" + adminText.slice(0, 20) + ":" + Math.floor(Date.now() / 3600e3);
  ctx.adm = ctx.adm !== undefined ? ctx.adm : await adminFor(env, db, chatId).catch(() => null);
  if (!ctx.adm) return;
  if (!ctx.adm.inChat) { if (await kv.get(db, k)) return; await kv.set(db, k, "1"); }
  const r = await toAdmin(env, db, { chatId, chatName: ctx.chatName, adm: ctx.adm, text: adminText, chase: true });
  (ctx.adminMsgs ||= []).push(...r.msgs);
}
async function tellAdmin(ctx, userText, adminText) {
  const { line, ev, chatId } = ctx;
  await escalateErr(ctx, adminText);
  const isAdm = ctx.adm && ctx.adm.id === ctx.userId;
  const msgs = [textMessage(isAdm ? userText + "\n" + adminText : userText + (ctx.adm ? (ctx.adm.inChat ? "" : `我已經跟 ${ctx.adm.name} 說了。`) : "")), ...(isAdm ? [] : ctx.adminMsgs || [])];
  return line.reply(ev.replyToken, msgs.slice(0, 5)).catch(e => console.log("reply failed", e.message));
}

function splitText(t, max) {
  const out = []; let rest = String(t || "");
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max); if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max); if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}
