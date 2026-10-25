// Session helpers for Pages Functions: Google ID-token verification, session cookies, JSON responses.
import { GOOGLE_CLIENT_ID, SESSION_DAYS } from "./config.js";

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

let jwksCache = { at: 0, keys: [] };
async function googleKeys() {
  if (Date.now() - jwksCache.at < 3600e3 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", { cf: { cacheTtl: 3600 } });
  const j = await r.json();
  jwksCache = { at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}

/* Verify a Google Sign-In credential (RS256 JWT). Returns the claims or throws. */
export async function verifyGoogle(token) {
  const [h, p, s] = String(token || "").split(".");
  if (!h || !p || !s) throw new Error("bad token");
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(h + "." + p));
  if (!ok) throw new Error("bad signature");
  const now = Date.now() / 1000;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("bad issuer");
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error("bad audience");
  if (!(claims.exp > now - 60)) throw new Error("expired");
  if (!claims.sub) throw new Error("no subject");
  return claims;
}

const COOKIE = "tt_s";
export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export function readToken(request) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)tt_s=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
export async function newSession(db, userId) {
  const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(raw), userId, Date.now() + SESSION_DAYS * 86400e3).run();
  return raw;
}
/* The signed-in user for this request, or null. */
export async function currentUser(request, db) {
  const t = readToken(request); if (!t) return null;
  const row = await db.prepare("SELECT u.id, u.email, u.name, u.picture, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
    .bind(await sha256(t)).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, picture: row.picture };
}
/* State-changing calls must come from our own pages (custom header forces a CORS preflight cross-site). */
export const sameSite = request => request.headers.get("x-tt") === "1";
