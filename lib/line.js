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
    leaveGroup: id => call(`/group/${id}/leave`, {}).catch(() => null),
    leaveRoom: id => call(`/room/${id}/leave`, {}).catch(() => null),
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
export const say = label => ({ type: "message", label: label.slice(0, 20), text: label });
export const postback = (label, data, displayText) => ({ type: "postback", label: label.slice(0, 20), data, displayText: displayText || label });
