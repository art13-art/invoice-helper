// 需要管理員（Ben）處理或決定的事：不叫別人「去找管理員」，直接 @他（他在這個群組時，跟著回覆一起送、不算則數），
// 不在群組或是在私訊裡，就私訊給他。要他決定的附「設定／不設定」按鈕（postback adm:<動作>:<id>）。
import { lineClient, mentionMessage, textMessage } from "./line.js";
import { kv, isGroup, rid } from "./assistant.js";
import { recordPush } from "./usage.js";

/* 找出這個聊天室可以 @ 的管理員：{ id, name, inChat } */
export async function adminFor(env, db, chatId) {
  const list = await kv.json(db, "admins", []);
  if (!list.length || !env.LINE_CHANNEL_TOKEN) return null;
  const line = lineClient(env.LINE_CHANNEL_TOKEN);
  if (isGroup(chatId)) for (const a of list) { const n = await line.name(chatId, a).catch(() => null); if (n) return { id: a, name: n, inChat: true }; }
  if (list.includes(chatId)) return { id: chatId, name: (await line.name(chatId, chatId).catch(() => null)) || "你", inChat: true };
  return { id: list[0], name: (await line.name(list[0], list[0]).catch(() => null)) || "管理員", inChat: false };
}

const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280" };
/* 要管理員決定的卡片 */
export function decisionCard(title, body, id, opts = {}) {
  const btn = (label, act, style) => ({ type: "button", style, height: "sm", ...(style === "primary" ? { color: C.brand } : { color: "#EEF2F1" }),
    action: { type: "postback", label, data: `adm:${act}:${id}`, displayText: label } });
  return {
    type: "flex", altText: title + "：" + body.slice(0, 80),
    contents: { type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "sm", contents: [
        { type: "text", text: title, weight: "bold", size: "sm", color: C.brand },
        { type: "text", text: body.slice(0, 400), size: "sm", color: C.ink, wrap: true },
        ...(opts.note ? [{ type: "text", text: opts.note, size: "xs", color: C.sub, wrap: true }] : [])] },
      footer: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", paddingTop: "0px", contents: [
        { type: "box", layout: "horizontal", spacing: "sm", contents: [btn(opts.yes || "設定", "ok", "primary"), btn("不設定", "no", "secondary")] },
        ...(opts.all ? [{ type: "button", style: "link", height: "sm", color: C.brand, action: { type: "postback", label: "所有群組都套用", data: `adm:all:${id}`, displayText: "所有群組都套用" } }] : [])] } },
  };
}

/* 建一筆等管理員決定的事，回傳 id */
export async function newDecision(db, { chatId, userId, kind, payload, summary }) {
  const id = rid(8);
  await db.prepare("INSERT INTO line_pending(id,chat_id,user_id,kind,payload,summary,created,status) VALUES(?,?,?,?,?,?,?,'open')")
    .bind(id, chatId, userId || null, kind, JSON.stringify(payload || {}), String(summary || "").slice(0, 500), Date.now()).run();
  return id;
}

/* 把要給管理員的話整理成訊息：在群組裡 → 回傳要接在回覆後面的訊息；不在 → 直接私訊他，回傳 [] */
export async function toAdmin(env, db, { chatId, chatName, adm, text, card }) {
  if (!adm) return { msgs: [], how: "none" };
  if (adm.inChat) return { msgs: [mentionMessage("{who} " + text, isGroup(chatId) ? adm.id : null), ...(card ? [card] : [])], how: "here" };
  const where = isGroup(chatId) ? `（${chatName || "某個群組"}）` : "（私訊）";
  try {
    await lineClient(env.LINE_CHANNEL_TOKEN).push(adm.id, [textMessage(where + text), ...(card ? [card] : [])]);
    await recordPush(db, adm.id, 1);
    return { msgs: [], how: "dm" };
  } catch (e) { console.log("admin push failed", e.message); return { msgs: [], how: "failed" }; }
}
