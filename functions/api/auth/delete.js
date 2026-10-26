// POST /api/auth/delete → permanently deletes the signed-in user's account and all cloud data.
import { json, currentUser, clearCookie, sameSite } from "../../../lib/auth.js";
export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const u = await currentUser(request, env.DB); if (!u) return json({ error: "請先登入" }, 401);
  const db = env.DB;
  // companies or firms the user owns that still have other members must be handed over or deleted first
  const owned = (await db.prepare("SELECT s.id, s.kind, s.name, (SELECT COUNT(*) FROM members m2 WHERE m2.space_id = s.id) AS n FROM spaces s WHERE s.owner_id = ?").bind(u.id).all()).results;
  const shared = owned.filter(s => s.kind !== "personal" && s.n > 1);
  if (shared.length) return json({ error: `「${shared.map(s => s.name).join("、")}」還有其他成員，請先刪除這些帳本或移除成員` }, 409);
  const ids = owned.map(s => s.id);
  const del = (sql) => ids.map(id => db.prepare(sql).bind(id));
  await db.batch([
    ...del("DELETE FROM items WHERE space_id = ?"), ...del("DELETE FROM history WHERE space_id = ?"), ...del("DELETE FROM invites WHERE space_id = ?"),
    ...del("DELETE FROM members WHERE space_id = ?"), ...del("UPDATE spaces SET firm_id = NULL WHERE firm_id = ?"), ...del("DELETE FROM spaces WHERE id = ?"),
    db.prepare("DELETE FROM members WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": clearCookie });
}
