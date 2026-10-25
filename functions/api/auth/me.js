// GET /api/auth/me → { user } or { user: null }
import { json, currentUser } from "../../../lib/auth.js";
export async function onRequestGet({ request, env }) {
  return json({ user: await currentUser(request, env.DB) });
}
