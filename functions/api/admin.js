// GET  /api/admin?days=30 → 後台數字：流量、會員、帳本使用、意見回饋（只有 ADMIN_EMAILS 能看）
// POST /api/admin { action:"feedback", id, status, note } → 更新回饋狀態
import { json, currentUser } from "../../lib/auth.js";
import { ADMIN_EMAILS } from "../../lib/config.js";
import { tpDay } from "../../lib/stats.js";

async function admin(request, db) {
  const u = await currentUser(request, db);
  if (!u) return { err: json({ error: "請先登入" }, 401) };
  if (!ADMIN_EMAILS.includes(String(u.email || "").toLowerCase())) return { err: json({ error: "這個帳號沒有後台權限" }, 403) };
  return { u };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB, a = await admin(request, db); if (a.err) return a.err;
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 7), 365);
  const now = Date.now(), from = tpDay(now - (days - 1) * 864e5), today = tpDay(now);
  const all = async (q, ...b) => (await db.prepare(q).bind(...b).all()).results;
  const one = async (q, ...b) => await db.prepare(q).bind(...b).first();
  const [views, vis, pages, refs, devs, users, newUsers, active, spaces, items, fb] = await Promise.all([
    all("SELECT day, SUM(n) v FROM stat_views WHERE day >= ? GROUP BY day", from),
    all("SELECT day, COUNT(*) u FROM stat_visitors WHERE day >= ? GROUP BY day", from),
    all("SELECT path, SUM(n) v FROM stat_views WHERE day >= ? GROUP BY path ORDER BY v DESC LIMIT 20", from),
    all("SELECT ref, SUM(n) v FROM stat_refs WHERE day >= ? GROUP BY ref ORDER BY v DESC LIMIT 15", from),
    all("SELECT dev, SUM(n) v FROM stat_devs WHERE day >= ? GROUP BY dev ORDER BY v DESC", from),
    one("SELECT COUNT(*) n FROM users"),
    all("SELECT date(created_at/1000, 'unixepoch', '+8 hours') day, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY day", now - days * 864e5),
    one("SELECT COUNT(*) n FROM users WHERE last_login >= ?", now - 7 * 864e5),
    all("SELECT kind, COUNT(*) n FROM spaces GROUP BY kind"),
    one("SELECT COUNT(*) n FROM items").catch(() => ({ n: null })),
    all("SELECT f.id, f.ts, f.page, f.kind, f.text, f.contact, f.status, f.note, u.email, u.name FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.ts DESC LIMIT 200"),
  ]);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = tpDay(now - i * 864e5);
    series.push({ day: d, views: views.find(r => r.day === d)?.v || 0, visitors: vis.find(r => r.day === d)?.u || 0, signups: newUsers.find(r => r.day === d)?.n || 0 });
  }
  const sum = (k, n) => series.slice(-n).reduce((s, r) => s + r[k], 0);
  return json({
    days, today,
    totals: { today: { views: sum("views", 1), visitors: sum("visitors", 1) }, d7: { views: sum("views", 7), visitors: sum("visitors", 7) }, period: { views: sum("views", days), visitors: sum("visitors", days) } },
    series, pages, refs, devs,
    members: { total: users.n, active7: active.n, newInPeriod: sum("signups", days), spaces: Object.fromEntries(spaces.map(s => [s.kind, s.n])), items: items?.n ?? null },
    feedback: fb,
  });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB, a = await admin(request, db); if (a.err) return a.err;
  if (request.headers.get("x-tt") !== "1") return json({ error: "bad request" }, 400);
  let b = {}; try { b = await request.json(); } catch (e) {}
  if (b.action === "feedback") {
    const status = ["new", "done", "ignored"].includes(b.status) ? b.status : null;
    if (!status) return json({ error: "bad status" }, 400);
    await db.prepare("UPDATE feedback SET status = ?, note = COALESCE(?, note) WHERE id = ?").bind(status, b.note == null ? null : String(b.note).slice(0, 500), Number(b.id)).run();
    return json({ ok: true });
  }
  if (b.action === "delete-feedback") {
    await db.prepare("DELETE FROM feedback WHERE id = ?").bind(Number(b.id)).run();
    return json({ ok: true });
  }
  return json({ error: "unknown action" }, 400);
}
