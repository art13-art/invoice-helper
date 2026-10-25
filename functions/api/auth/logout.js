// POST /api/auth/logout → ends this session.
import { json, readToken, sha256, clearCookie, sameSite } from "../../../lib/auth.js";
export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const t = readToken(request);
  if (t) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256(t)).run();
  return json({ ok: true }, 200, { "set-cookie": clearCookie });
}
