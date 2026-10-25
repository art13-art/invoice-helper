// POST /api/auth/google  { credential }  → signs in with a Google ID token and sets the session cookie.
import { json, verifyGoogle, newSession, sessionCookie, sameSite } from "../../../lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  let c; try { c = await verifyGoogle(body.credential); } catch (e) { return json({ error: "Google 登入驗證失敗，請再試一次" }, 401); }
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO users (id, email, name, picture, created_at, last_login) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3, picture = ?4, last_login = ?5`)
    .bind(c.sub, c.email || "", c.name || "", c.picture || "", now).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(c.sub, now).run();
  const token = await newSession(env.DB, c.sub);
  return json({ user: { id: c.sub, email: c.email, name: c.name, picture: c.picture } }, 200, { "set-cookie": sessionCookie(token) });
}
