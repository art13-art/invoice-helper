// GET /bo/img?k=<後台代碼>&id=<帳單>&n=<第幾張> — 後台看帳單照片（任何群組的）
import { staff } from "./index.js";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (!(await staff(env.DB, u.searchParams.get("k") || ""))) return new Response("not found", { status: 404 });
  const r = await env.DB.prepare("SELECT mime, data FROM line_split_imgs WHERE split_id=? AND n=?").bind(u.searchParams.get("id") || "", Number(u.searchParams.get("n")) || 0).first();
  if (!r) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(r.data), { headers: { "content-type": r.mime || "image/jpeg", "cache-control": "private, max-age=86400" } });
}
