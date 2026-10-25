// GET /api/health → confirms the database binding works (no user data).
import { json } from "../../lib/auth.js";
import { GOOGLE_CLIENT_ID } from "../../lib/config.js";
export async function onRequestGet({ env }) {
  let db = "missing";
  try { if (env.DB) { await env.DB.prepare("SELECT 1").first(); db = "ok"; } } catch (e) { db = "error"; }
  return json({ db, google: /^PENDING/.test(GOOGLE_CLIENT_ID) ? "pending" : "ready" });
}
