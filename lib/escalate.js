// 需要管理員（Ben）處理或決定的事：不叫別人「去找管理員」，直接 @他（他在這個群組時，跟著回覆一起送、不算則數），
// 不在群組或是在私訊裡，就私訊給他。要他決定的附「設定／不設定」按鈕（postback adm:<動作>:<id>）。
import { lineClient, mentionMessage, textMessage } from "./line.js";
import { kv, isGroup, rid, quiet, md, ymd, hm } from "./assistant.js";
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
  if (adm.inChat) {
    if (isGroup(chatId)) await startChase(db, { chatId, adminId: adm.id, from: "小幫手", text }).catch(e => console.log("chase", e.message));
    return { msgs: [mentionMessage("{who} " + text, isGroup(chatId) ? adm.id : null), ...(card ? [card] : [])], how: "here" };
  }
  const where = isGroup(chatId) ? `（${chatName || "某個群組"}）` : "（私訊）";
  try {
    await lineClient(env.LINE_CHANNEL_TOKEN).push(adm.id, [textMessage(where + text), ...(card ? [card] : [])]);
    await recordPush(db, adm.id, 1);
    return { msgs: [], how: "dm" };
  } catch (e) { console.log("admin push failed", e.message); return { msgs: [], how: "failed" }; }
}

/* ---------- 有人找管理員，3 小時沒回就再 @ 一次 ---------- */
const CHASE_AFTER = 3 * 3600e3;
const ASKING = /幫|請|麻煩|確認|看一下|看看|回覆|回一下|處理|決定|簽|核准|同意|可以嗎|可不可以|能不能|要不要|好嗎|嗎[?？]?$|[?？]/;

/* 開始追：同一個群組同一個人已經在追了，就只把內容補上去 */
export async function startChase(db, { chatId, adminId, from, text }) {
  const snip = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const open = await db.prepare("SELECT id,text FROM line_reminders WHERE chat_id=? AND kind='chase' AND mention_id=? AND status='open'").bind(chatId, adminId).first();
  if (open) {
    const n = (Number((open.text.match(/（共 (\d+) 件）/) || [])[1]) || 1) + 1;
    await db.prepare("UPDATE line_reminders SET text=? WHERE id=?").bind(open.text.replace(/（共 \d+ 件）/, "") + `（共 ${n} 件）`, open.id).run();
    return open.id;
  }
  const id = rid(6), due = quiet(Date.now() + CHASE_AFTER);
  await db.prepare("INSERT INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status,kind) VALUES(?,?,?,?,'none',?,NULL,NULL,?,NULL,'open','chase')")
    .bind(id, chatId, due, `${from || "有人"} ${md(ymd())} ${hm(Date.now())} 找你：「${snip}」，還沒看到你回。`, adminId, Date.now()).run();
  return id;
}

/* 群組裡每則訊息都看一下：管理員自己說話＝回應了，取消追；有人 @管理員、或叫他名字請他做事＝開始追 */
export async function watchAdmin(env, db, { chatId, userId, name, text, mentionees }) {
  if (!isGroup(chatId)) return;
  const admins = await kv.json(db, "admins", []);
  if (!admins.length) return;
  if (admins.includes(userId)) {
    await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE chat_id=? AND kind='chase' AND mention_id=? AND status='open'").bind(chatId, userId).run();
    return;
  }
  const tagged = (mentionees || []).filter(m => m.type === "user" && admins.includes(m.userId)).map(m => m.userId);
  let targets = [...new Set(tagged)];
  // 直接對小幫手說的話（@小幫手）是交辦給小幫手，不算在找管理員；需要管理員時小幫手自己會 @ 他
  const toBot = (mentionees || []).some(m => m.isSelf) || /[@＠]\s?小幫手/.test(String(text || ""));
  const plain = String(text || "").replace(/@?小幫手|@?小助理/g, "");
  if (!targets.length && !toBot && plain && ASKING.test(plain)) {
    // 沒 @，但叫了管理員的名字（群組裡看過他的名字才認得）
    for (const a of admins) {
      const row = await db.prepare("SELECT name FROM line_members WHERE chat_id=? AND user_id=?").bind(chatId, a).first();
      const nm = row?.name && row.name.trim();
      if (nm && nm.length >= 2 && text.toLowerCase().includes(nm.toLowerCase())) targets.push(a);
    }
  }
  for (const a of targets) await startChase(db, { chatId, adminId: a, from: name, text });
}
