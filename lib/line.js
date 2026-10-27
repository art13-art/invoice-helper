// LINE Messaging API helpers: signature check, reply/push, loading indicator, image download.
const API = "https://api.line.me/v2/bot";
const DATA = "https://api-data.line.me/v2/bot";

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

/* LINE signs the raw request body with the channel secret (HMAC-SHA256, base64). */
export async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  if (mac.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export function lineClient(token) {
  const call = async (path, body, base = API) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ""); const e = new Error(`LINE ${path} ${r.status} ${t.slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json().catch(() => ({}));
  };
  return {
    reply: (replyToken, messages) => call("/message/reply", { replyToken, messages }),
    push: (to, messages) => call("/message/push", { to, messages }),
    loading: (chatId, loadingSeconds = 20) => call("/chat/loading/start", { chatId, loadingSeconds }).catch(() => null),
    /* 顯示名稱：群組成員、多人聊天成員或好友（免費、不計則數） */
    async name(chatId, userId) {
      const path = chatId.startsWith("C") ? `/group/${chatId}/member/${userId}` : chatId.startsWith("R") ? `/room/${chatId}/member/${userId}` : `/profile/${userId}`;
      const r = await fetch(API + path, { headers: { authorization: "Bearer " + token } });
      if (!r.ok) return null;
      return (await r.json()).displayName || null;
    },
    async memberCount(chatId) {
      const p = String(chatId).startsWith("C") ? `/group/${chatId}/members/count` : String(chatId).startsWith("R") ? `/room/${chatId}/members/count` : null;
      if (!p) return 1;
      const r = await fetch(API + p, { headers: { authorization: "Bearer " + token } }).catch(() => null);
      return r && r.ok ? ((await r.json()).count || 1) : 1;
    },
    async groupName(groupId) {
      if (!String(groupId).startsWith("C")) return null;
      const r = await fetch(`${API}/group/${groupId}/summary`, { headers: { authorization: "Bearer " + token } }).catch(() => null);
      return r && r.ok ? (await r.json()).groupName || null : null;
    },
    async quota() {
      const [a, b] = await Promise.all(["/message/quota", "/message/quota/consumption"].map(p => fetch(API + p, { headers: { authorization: "Bearer " + token } }).then(r => r.json()).catch(() => ({}))));
      return { limit: a.type === "limited" ? a.value : null, used: b.totalUsage ?? null };
    },
    leaveGroup: id => call(`/group/${id}/leave`, {}).catch(() => null),
    leaveRoom: id => call(`/room/${id}/leave`, {}).catch(() => null),
    /* 原始檔案（照片、檔案）：{ type, bytes } */
    async content(messageId, max = 20 * 1024 * 1024) {
      const r = await fetch(`${DATA}/message/${messageId}/content`, { headers: { authorization: "Bearer " + token } });
      if (!r.ok) throw new Error("content " + r.status);
      const buf = await r.arrayBuffer();
      if (buf.byteLength > max) throw new Error(`檔案太大（超過 ${Math.round(max / 1048576)}MB）`);
      return { type: (r.headers.get("content-type") || "").split(";")[0], bytes: new Uint8Array(buf) };
    },
    async image(messageId) {
      const r = await fetch(`${DATA}/message/${messageId}/content`, { headers: { authorization: "Bearer " + token } });
      if (!r.ok) throw new Error("image " + r.status);
      const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 4.5 * 1024 * 1024) throw new Error("image too large");
      let s = ""; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { type, data: btoa(s) };
    },
  };
}

/* A text message, cut to LINE's 5000-character limit, with optional quick-reply chips. */
export function textMessage(text, quick) {
  const m = { type: "text", text: String(text || "").slice(0, 4900) || "（沒有內容）" };
  if (quick && quick.length) m.quickReply = { items: quick.slice(0, 13).map(q => ({ type: "action", action: q })) };
  return m;
}
/* 文字裡的 {who} 會變成 @某人：who 可以是一個 userId、多個（陣列或逗號分隔）、或 "all"（@All）。LINE textV2 mention */
export function mentionMessage(text, who, quick) {
  const list = who === "all" ? ["all"] : (Array.isArray(who) ? who : String(who || "").split(",")).map(s => String(s).trim()).filter(Boolean).slice(0, 20);
  const safe = s => String(s).replace(/\{/g, "｛").replace(/\}/g, "｝");   // 內容裡的大括號會被當成 mention 代號
  if (!list.length || !text.includes("{who}")) return textMessage(safe(text.replace("{who}", "")).trim(), quick);
  const keys = list.map((_, i) => "m" + i);
  const body = String(text).split("{who}").map(safe).join(keys.map(k => `{${k}}`).join(" "));
  const sub = Object.fromEntries(list.map((id, i) => [keys[i], { type: "mention", mentionee: id === "all" ? { type: "all" } : { type: "user", userId: id } }]));
  const m = { type: "textV2", text: body.slice(0, 4900), substitution: sub };
  if (quick && quick.length) m.quickReply = { items: quick.slice(0, 13).map(q => ({ type: "action", action: q })) };
  return m;
}
/* 待辦到期／逾期提醒下面那張「✓ 已完成」小卡（按鈕不會像快速回覆一樣被新訊息蓋掉） */
export function doneCard(todoId, task) {
  return {
    type: "flex", altText: "做完了按「已完成」：" + String(task || "").slice(0, 60),
    contents: { type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", paddingAll: "12px", contents: [{ type: "text", text: "做完了按下面，之後就不再提醒。", size: "sm", color: "#555555", wrap: true }] },
      footer: { type: "box", layout: "vertical", paddingAll: "8px", contents: [{ type: "button", style: "primary", color: "#12524F", height: "sm",
        action: { type: "postback", label: "✓ 已完成", data: "done:" + todoId, displayText: "✓ 已完成：" + String(task || "").slice(0, 40) } }] } },
  };
}
/* 會議錄音整理後附的卡片：2. 逐字稿（連結）、3. 是否需要提醒（要／不用） */
export function meetingCard({ txId, minutes, speakers, url }) {
  const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280", line: "#E5E7EB" };
  return {
    type: "flex", altText: "會議錄音整理：逐字稿、是否需要提醒",
    contents: { type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
        { type: "text", text: "會議錄音整理", color: "#FFFFFF", weight: "bold", size: "md" },
        { type: "text", text: `約 ${Math.max(1, Math.round(minutes || 1))} 分鐘${speakers ? "・已分辨說話者" : ""}`, color: "#CFE3E1", size: "xs", margin: "xs" }] },
      body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "md", contents: [
        { type: "box", layout: "horizontal", alignItems: "center", contents: [
          { type: "text", text: "2. 逐字稿", weight: "bold", size: "sm", color: C.ink, flex: 0 },
          url ? { type: "text", text: "開啟 Google 文件 ›", size: "sm", color: C.brand, weight: "bold", align: "end", action: { type: "uri", label: "開啟逐字稿", uri: url } }
              : { type: "text", text: "留在小幫手 30 天，可直接問", size: "xs", color: C.sub, align: "end", wrap: true }] },
        { type: "separator", color: C.line },
        { type: "text", text: "3. 是否需要提醒？", weight: "bold", size: "sm", color: C.ink }] },
      footer: { type: "box", layout: "horizontal", spacing: "sm", paddingAll: "14px", paddingTop: "0px", contents: [
        { type: "button", style: "primary", color: C.brand, height: "sm", flex: 3, action: { type: "postback", label: "要，設提醒", data: "txr:yes:" + txId, displayText: "要，幫我設提醒" } },
        { type: "button", style: "secondary", color: "#EEF2F1", height: "sm", flex: 2, action: { type: "postback", label: "不用", data: "txr:no:" + txId, displayText: "不用提醒" } }] } },
  };
}
export const say = label => ({ type: "message", label: label.slice(0, 20), text: label });
export const postback = (label, data, displayText) => ({ type: "postback", label: label.slice(0, 20), data, displayText: displayText || label });
