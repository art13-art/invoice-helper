// POST /api/auth/delete → permanently deletes the signed-in user's account and all cloud data.
import { json, currentUser, clearCookie, sameSite } from "../../../lib/auth.js";
export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const u = await currentUser(request, env.DB); if (!u) return json({ error: "請先登入" }, 401);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM items WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": clearCookie });
}
