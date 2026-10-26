// POST /api/line/webhook — LINE 官方帳號的 Webhook。
// 只服務綁定的擁有者；先回 200 給 LINE，再在背景呼叫 Claude 和帳本。
import { verifySignature, lineClient, textMessage, say, postback } from "../../../lib/line.js";
import { chat, confirmPending, composeBrief, kv, HELP } from "../../../lib/assistant.js";

const CHIPS = [say("本月支出"), say("待確認的帳"), say("今日重點"), say("我的提醒"), say("說明")];

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

async function handle(env, ev, origin) {
  const db = env.DB, line = lineClient(env.LINE_CHANNEL_TOKEN);
  // LINE 可能重送同一個事件
  if (ev.webhookEventId) {
    const r = await db.prepare("INSERT OR IGNORE INTO line_events(id,ts) VALUES(?,?)").bind(ev.webhookEventId, Date.now()).run();
    if ((r.meta?.changes ?? 1) === 0) return;
    if (Math.random() < 0.02) await db.prepare("DELETE FROM line_events WHERE ts<?").bind(Date.now() - 7 * 864e5).run();
  }
  const src = ev.source || {};
  const reply = msgs => ev.replyToken ? line.reply(ev.replyToken, Array.isArray(msgs) ? msgs : [msgs]) : null;

  // 第一版只做個人助理：被拉進群組就說明後離開
  if (src.type === "group" || src.type === "room") {
    if (ev.type === "join") {
      await reply(textMessage("嗨！我目前是私人記帳助理，還沒開放群組功能，先離開囉。"));
      if (src.type === "group") await line.leaveGroup(src.groupId); else await line.leaveRoom(src.roomId);
    }
    return;
  }
  const userId = src.userId;
  if (!userId) return;
  const owner = await kv.get(db, "owner");
  const text = ev.type === "message" && ev.message?.type === "text" ? ev.message.text.trim() : "";

  if (!owner) {
    if (text === "綁定") {
      await kv.set(db, "owner", userId);
      return reply(textMessage("綁定完成，之後我只會服務你。\n\n" + HELP, CHIPS));
    }
    if (ev.type === "follow" || ev.type === "message") return reply(textMessage("你好！第一次使用請輸入「綁定」，把這個助理設定成你專屬的。"));
    return;
  }
  if (userId !== owner) {
    if (ev.type === "follow" || ev.type === "message") return reply(textMessage("這是私人助理，目前只服務擁有者，謝謝你。"));
    return;
  }

  const ctx = { env, db, userId, origin, pending: null };
  if (ev.type === "follow") return reply(textMessage("歡迎回來！\n\n" + HELP, CHIPS));
  if (ev.type === "postback") {
    const m = String(ev.postback?.data || "").match(/^(ok|no):(\w+)$/);
    if (!m) return;
    const msg = await confirmPending(ctx, m[2], m[1] === "ok");
    return reply(textMessage(msg, CHIPS));
  }
  if (ev.type !== "message") return;

  const type = ev.message.type;
  if (type === "text") {
    if (/^(說明|help|\?|？|怎麼用)$/i.test(text)) return reply(textMessage(HELP, CHIPS));
    if (text === "今日重點") {
      await line.loading(userId, 15);
      return reply(textMessage(await composeBrief(env, db, userId, origin), CHIPS));
    }
    if (/^(確認|好|ok|OK|對)$/.test(text)) {
      const p = await db.prepare("SELECT id FROM line_pending WHERE user_id=? AND status='open' ORDER BY created DESC LIMIT 1").bind(userId).first();
      if (p) return reply(textMessage(await confirmPending(ctx, p.id, true), CHIPS));
    }
    if (text === "取消") {
      const p = await db.prepare("SELECT id FROM line_pending WHERE user_id=? AND status='open' ORDER BY created DESC LIMIT 1").bind(userId).first();
      if (p) return reply(textMessage(await confirmPending(ctx, p.id, false), CHIPS));
    }
    return answer(ctx, line, ev, [{ type: "text", text }], text);
  }
  if (type === "image") {
    await line.loading(userId, 30);
    let img;
    try { img = await line.image(ev.message.id); } catch (e) { return reply(textMessage("照片讀取失敗，可以再傳一次或直接打字告訴我。")); }
    return answer(ctx, line, ev, [
      { type: "image", source: { type: "base64", media_type: img.type, data: img.data } },
      { type: "text", text: "（使用者傳來一張照片。如果是發票或收據，整理成帳並準備記帳；不是的話就簡短說明看到什麼、問要怎麼處理。）" },
    ], "（傳了一張照片）");
  }
  if (type === "sticker") return reply(textMessage("😊 有需要記帳或提醒，直接打字跟我說就好。", CHIPS));
  if (type === "audio") return reply(textMessage("語音訊息之後會支援，現在先用打字告訴我好嗎？"));
  return reply(textMessage("這種訊息我還看不懂，可以用文字或照片告訴我。"));
}

async function answer(ctx, line, ev, content, logText) {
  const { env } = ctx;
  if (!env.ANTHROPIC_API_KEY) return line.reply(ev.replyToken, [textMessage("AI 金鑰還沒設定好，目前只能用「說明」「今日重點」。", CHIPS)]);
  await line.loading(ctx.userId, 30);
  let out;
  try { out = await chat(ctx, content, logText); }
  catch (e) {
    console.log("chat error", e.message);
    out = { text: e.status === 401 ? "AI 金鑰不正確，請檢查 Cloudflare 設定。" : e.status === 429 || e.status === 529 ? "AI 現在比較忙，請過一分鐘再試。" : "我這邊出了點問題，請稍後再試一次。" };
  }
  const quick = out.pending ? [postback(out.pending.label, "ok:" + out.pending.id, "確認"), postback("✕ 取消", "no:" + out.pending.id, "取消")] : CHIPS;
  const msg = textMessage(out.text, quick);
  try { await line.reply(ev.replyToken, [msg]); }
  catch (e) { await line.push(ctx.userId, [msg]); }   // 回覆權杖過期時改用推播（會計入每月則數）
}
