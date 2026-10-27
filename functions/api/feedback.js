// POST /api/feedback { kind, text, contact?, page } → 存一則意見回饋（同一位訪客每天最多 10 則）。
import { json, currentUser } from "../../lib/auth.js";
import { tpDay, visitorHash, cleanPath } from "../../lib/stats.js";
const KINDS = ["建議", "錯誤", "問題", "其他"];
export async function onRequestPost({ request, env }) {
  if (request.headers.get("x-tt") !== "1") return json({ error: "bad request" }, 400);
  let b = {}; try { b = await request.json(); } catch (e) {}
  const text = String(b.text || "").trim().slice(0, 2000);
  if (text.length < 2) return json({ error: "請寫一下內容" }, 400);
  const db = env.DB, day = tpDay();
  const iph = await visitorHash(request, env, day);
  const n = await db.prepare("SELECT COUNT(*) n FROM feedback WHERE iph = ? AND ts > ?").bind(iph, Date.now() - 864e5).first();
  if (n.n >= 10) return json({ error: "今天送出太多則了，明天再試或寄信給我們" }, 429);
  const u = await currentUser(request, db).catch(() => null);
  await db.prepare("INSERT INTO feedback (ts, page, kind, text, contact, user_id, iph) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(Date.now(), cleanPath(b.page), KINDS.includes(b.kind) ? b.kind : "其他", text, String(b.contact || "").trim().slice(0, 120) || null, u?.id || null, iph).run();
  return json({ ok: true });
}
