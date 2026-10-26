// POST /api/sync { space, since, changes: [{ id, kind, data, updated_at, deleted }] }
//   Stores the caller's changes they are allowed to make (last write wins by updated_at), records entry history,
//   and returns everything in the space changed since `since` that the caller may see.
//   Changes refused by permissions or a locked period come back in `rejected`, with the server copy in `items`.
import { json, currentUser, sameSite } from "../../lib/auth.js";
import { getSpace, roleIn, canWrite, canLock } from "../../lib/spaces.js";

const MAX_CHANGES = 400, MAX_ITEM = 16000, MAX_ITEMS = 50000, PAGE = 3000;
const KINDS = { personal: ["book", "entry", "recur", "pref", "lock"], company: ["book", "entry", "recur", "comment", "lock", "pref"], firm: ["pref"] };
const month = d => (typeof d === "string" ? d.slice(0, 7) : "");
const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const db = env.DB, u = await currentUser(request, db); if (!u) return json({ error: "請先登入" }, 401);
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const space = await getSpace(db, String(body.space || "")); const role = await roleIn(db, u.id, space);
  if (!space || !role) return json({ error: "找不到這個帳本或沒有權限" }, 404);
  const since = Math.max(0, Number(body.since) || 0);
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
  const now = Date.now(), rejected = [];

  if (changes.length) {
    if (role === "viewer") changes.forEach(c => rejected.push({ id: String(c.id), reason: "檢視者不能修改" }));
    else {
      const count = (await db.prepare("SELECT COUNT(*) AS n FROM items WHERE space_id = ?").bind(space.id).first()).n;
      if (count + changes.length > MAX_ITEMS) return json({ error: "這本帳已達 5 萬筆上限" }, 413);
      // current rows for the touched ids (chunked: D1 caps bound parameters)
      const ids = [...new Set(changes.map(c => String(c.id)))], cur = {};
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        const rows = (await db.prepare(`SELECT * FROM items WHERE space_id = ? AND id IN (${part.map(() => "?").join(",")})`).bind(space.id, ...part).all()).results;
        rows.forEach(r => cur[r.id] = r);
      }
      const locks = (await db.prepare("SELECT data FROM items WHERE space_id = ? AND kind = 'lock' AND deleted = 0").bind(space.id).all()).results.map(r => parse(r.data)).filter(Boolean);
      const isLocked = d => { const m = month(d); return !!m && locks.some(l => m >= l.from && m <= l.to); };
      const lockOk = canLock(role, space);
      const stmts = [];
      for (const c of changes) {
        const id = String(c.id || ""), kind = String(c.kind || ""), old = cur[id];
        const no = reason => rejected.push({ id, reason });
        if (!/^[\w-]{4,64}$/.test(id) || !(KINDS[space.kind] || []).includes(kind)) { no("格式不正確"); continue; }
        if (old && old.kind !== kind) { no("格式不正確"); continue; }
        const data = c.deleted ? null : (c.data ?? {});
        const text = data ? JSON.stringify(data) : null;
        if (text && text.length > MAX_ITEM) { no("內容太長"); continue; }
        const oldData = old ? parse(old.data) : null;
        // permissions by kind
        if (kind === "entry") {
          if (role === "submitter" && old && old.created_by !== u.id) { no("報帳人員只能修改自己記的帳"); continue; }
          if (!lockOk && (isLocked(data?.date) || isLocked(oldData?.date))) { no("這一期已經鎖帳，請聯絡事務所"); continue; }
        } else if (kind === "comment") {
          if (old && old.created_by !== u.id && !canWrite(role)) { no("只能修改自己的留言"); continue; }
        } else if (kind === "lock") {
          if (!lockOk) { no("只有事務所可以鎖帳"); continue; }
        } else if (!canWrite(role)) { no("沒有權限"); continue; }
        const upd = Math.min(Number(c.updated_at) || now, now + 60e3);
        if (old && old.updated_at >= upd) continue;               // an equal or newer version is already stored
        stmts.push(db.prepare(`INSERT INTO items (space_id, id, kind, data, updated_at, deleted, srv, created_by, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
          ON CONFLICT(space_id, id) DO UPDATE SET data = ?4, updated_at = ?5, deleted = ?6, srv = ?7, updated_by = ?8`)
          .bind(space.id, id, kind, text, upd, c.deleted ? 1 : 0, now, u.id));
        if (kind === "entry" && (space.kind === "company")) {
          stmts.push(db.prepare("INSERT INTO history (space_id, item_id, at, user_id, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(space.id, id, now, u.id, c.deleted ? "delete" : old && !old.deleted ? "update" : "create", old ? old.data : null, text));
        }
      }
      for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
    }
  }

  // what this caller may see
  let sql = "SELECT * FROM items WHERE space_id = ?1 AND srv >= ?2", args = [space.id, since];
  if (role === "submitter") {
    sql += ` AND (kind IN ('book','lock') OR created_by = ?3 OR (kind = 'comment' AND json_extract(data,'$.entry') IN (SELECT id FROM items WHERE space_id = ?1 AND kind = 'entry' AND created_by = ?3)))`;
    args.push(u.id);
  }
  const rows = (await db.prepare(sql + ` ORDER BY srv LIMIT ${PAGE}`).bind(...args).all()).results || [];
  const pack = r => ({ id: r.id, kind: r.kind, data: parse(r.data), updated_at: r.updated_at, deleted: !!r.deleted, by: r.created_by, upd: r.updated_by });
  const items = rows.map(pack);
  // send back the authoritative copy of anything refused, so the device can undo its local change
  for (const r of rejected) {
    if (items.some(i => i.id === r.id)) continue;
    const row = await db.prepare("SELECT * FROM items WHERE space_id = ? AND id = ?").bind(space.id, r.id).first();
    items.push(row ? { ...pack(row), force: true } : { id: r.id, deleted: true, gone: true, force: true });
  }
  const srv = rows.length ? Math.max(...rows.map(r => r.srv)) : since;
  return json({ srv, items, rejected, more: rows.length === PAGE, role });
}
