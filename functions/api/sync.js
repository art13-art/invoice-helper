// POST /api/sync  { since, changes: [{ id, kind, data, updated_at, deleted }] }
//   → stores newer changes (last write wins by updated_at) and returns everything changed after `since`.
import { json, currentUser, sameSite } from "../../lib/auth.js";

const MAX_CHANGES = 500, MAX_ITEM = 16000, MAX_ITEMS = 50000;
const KINDS = new Set(["entry", "book", "recur", "pref"]);

export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const u = await currentUser(request, env.DB); if (!u) return json({ error: "請先登入" }, 401);
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const since = Math.max(0, Number(body.since) || 0);
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
  const now = Date.now();

  if (changes.length) {
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?").bind(u.id).first()).n;
    if (count + changes.length > MAX_ITEMS) return json({ error: "雲端帳本已達 5 萬筆上限" }, 413);
    const stmts = [];
    for (const c of changes) {
      const id = String(c.id || ""), kind = String(c.kind || "");
      if (!/^[\w-]{6,64}$/.test(id) || !KINDS.has(kind)) continue;
      const data = c.deleted ? null : JSON.stringify(c.data ?? {});
      if (data && data.length > MAX_ITEM) continue;
      const upd = Math.min(Number(c.updated_at) || now, now + 60e3);
      stmts.push(env.DB.prepare(`INSERT INTO items (user_id, id, kind, data, updated_at, deleted, srv) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(user_id, id) DO UPDATE SET kind = ?3, data = ?4, updated_at = ?5, deleted = ?6, srv = ?7 WHERE excluded.updated_at > items.updated_at`)
        .bind(u.id, id, kind, data, upd, c.deleted ? 1 : 0, now));
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  const rows = (await env.DB.prepare("SELECT id, kind, data, updated_at, deleted, srv FROM items WHERE user_id = ? AND srv >= ? ORDER BY srv LIMIT 5000")
    .bind(u.id, since).all()).results || [];
  const items = rows.map(r => ({ id: r.id, kind: r.kind, data: r.data ? JSON.parse(r.data) : null, updated_at: r.updated_at, deleted: !!r.deleted }));
  const srv = rows.length ? Math.max(...rows.map(r => r.srv)) : since;
  return json({ srv, items, more: rows.length === 5000 });
}
