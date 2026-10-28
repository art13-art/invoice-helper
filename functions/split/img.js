// GET /split/img?t=<群組代碼>&id=<帳單>&n=<第幾張> — 帳單照片
import { kv } from "../../lib/assistant.js";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), t = u.searchParams.get("t") || "";
  const chatId = t.length >= 20 ? await kv.get(env.DB, "splittok:" + t) : null;
  if (!chatId) return new Response("not found", { status: 404 });
  const r = await env.DB.prepare("SELECT i.mime, i.data FROM line_split_imgs i JOIN line_splits s ON s.id=i.split_id WHERE i.split_id=? AND i.n=? AND s.chat_id=?")
    .bind(u.searchParams.get("id") || "", Number(u.searchParams.get("n")) || 0, chatId).first();
  if (!r) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(r.data), { headers: { "content-type": r.mime || "image/jpeg", "cache-control": "private, max-age=86400" } });
}
