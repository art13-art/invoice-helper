// GET /api/firm?space=FIRM&from=YYYY-MM&to=YYYY-MM
//   For 記帳士事務所 staff: every linked client with this period's activity, missing invoices, open questions and VAT estimate.
import { json, currentUser } from "../../lib/auth.js";
import { getSpace } from "../../lib/spaces.js";

export async function onRequestGet({ request, env }) {
  const db = env.DB, u = await currentUser(request, db); if (!u) return json({ error: "請先登入" }, 401);
  const q = new URL(request.url).searchParams;
  const f = await getSpace(db, String(q.get("space") || ""));
  const m = f && await db.prepare("SELECT role FROM members WHERE space_id = ? AND user_id = ?").bind(f.id, u.id).first();
  if (!f || f.kind !== "firm" || !m) return json({ error: "沒有權限" }, 403);
  const from = /^\d{4}-\d{2}$/.test(q.get("from") || "") ? q.get("from") : new Date().toISOString().slice(0, 7);
  const to = /^\d{4}-\d{2}$/.test(q.get("to") || "") ? q.get("to") : from;
  const rows = (await db.prepare(`
    SELECT s.id, s.name, s.ubn, s.created_at,
      (SELECT u.name FROM users u WHERE u.id = s.owner_id) AS owner,
      (SELECT COUNT(*) FROM members mm WHERE mm.space_id = s.id) AS members,
      (SELECT MAX(i.updated_at) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry') AS last,
      (SELECT COUNT(*) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry' AND i.deleted = 0 AND substr(json_extract(i.data,'$.date'),1,7) BETWEEN ?2 AND ?3) AS n,
      (SELECT COALESCE(SUM(json_extract(i.data,'$.amount')),0) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry' AND i.deleted = 0 AND json_extract(i.data,'$.type') = 'in' AND substr(json_extract(i.data,'$.date'),1,7) BETWEEN ?2 AND ?3) AS income,
      (SELECT COALESCE(SUM(json_extract(i.data,'$.amount')),0) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry' AND i.deleted = 0 AND json_extract(i.data,'$.type') = 'out' AND substr(json_extract(i.data,'$.date'),1,7) BETWEEN ?2 AND ?3) AS expense,
      (SELECT COALESCE(SUM(json_extract(i.data,'$.tax')),0) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry' AND i.deleted = 0 AND json_extract(i.data,'$.type') = 'in' AND json_extract(i.data,'$.doc') = 'inv' AND substr(json_extract(i.data,'$.date'),1,7) BETWEEN ?2 AND ?3) AS outTax,
      (SELECT COALESCE(SUM(json_extract(i.data,'$.tax')),0) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry' AND i.deleted = 0 AND json_extract(i.data,'$.type') = 'out' AND json_extract(i.data,'$.doc') = 'inv' AND json_extract(i.data,'$.cat') != '交際' AND substr(json_extract(i.data,'$.date'),1,7) BETWEEN ?2 AND ?3) AS inTax,
      (SELECT COUNT(*) FROM items i WHERE i.space_id = s.id AND i.kind = 'entry' AND i.deleted = 0 AND json_extract(i.data,'$.type') = 'out' AND COALESCE(json_extract(i.data,'$.doc'),'none') != 'inv' AND substr(json_extract(i.data,'$.date'),1,7) BETWEEN ?2 AND ?3) AS noInv,
      (SELECT COUNT(*) FROM items i WHERE i.space_id = s.id AND i.kind = 'comment' AND i.deleted = 0 AND COALESCE(json_extract(i.data,'$.resolved'),0) = 0) AS openQ,
      (SELECT COUNT(*) FROM items i WHERE i.space_id = s.id AND i.kind = 'lock' AND i.deleted = 0 AND json_extract(i.data,'$.from') <= ?2 AND json_extract(i.data,'$.to') >= ?3) AS locked
    FROM spaces s WHERE s.kind = 'company' AND s.firm_id = ?1 ORDER BY s.name`).bind(f.id, from, to).all()).results;
  return json({ firm: { id: f.id, name: f.name }, from, to, clients: rows });
}
