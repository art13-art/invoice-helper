// GET  /api/spaces → the signed-in user's spaces (personal, companies, firms) with roles, members and firm branding.
// POST /api/spaces { action, ... } → create | update | setRole | remove | leave | unlinkFirm | deleteSpace
import { json, currentUser, sameSite } from "../../lib/auth.js";
import { getSpace, roleIn, ensurePersonal, createCompany, newId, cleanName, cleanUbn, cleanProfile, ROLES } from "../../lib/spaces.js";

const prof = s => { try { return JSON.parse(s.profile || "{}"); } catch { return {}; } };

export async function onRequestGet({ request, env }) {
  const db = env.DB, u = await currentUser(request, db); if (!u) return json({ user: null, spaces: [] });
  await ensurePersonal(db, u);
  // direct memberships + companies reachable through a firm the user works at
  const direct = (await db.prepare("SELECT s.*, m.role FROM spaces s JOIN members m ON m.space_id = s.id WHERE m.user_id = ? ORDER BY s.kind = 'personal' DESC, s.created_at").bind(u.id).all()).results;
  const firmIds = direct.filter(s => s.kind === "firm").map(s => s.id);
  let viaFirm = [];
  if (firmIds.length) {
    viaFirm = (await db.prepare(`SELECT s.* FROM spaces s WHERE s.kind = 'company' AND s.firm_id IN (${firmIds.map(() => "?").join(",")}) ORDER BY s.name`).bind(...firmIds).all()).results
      .filter(s => !direct.some(d => d.id === s.id))
      .map(s => ({ ...s, role: (direct.find(d => d.id === s.firm_id).role === "viewer") ? "viewer" : "firm" }));
  }
  const all = [...direct, ...viaFirm];
  const firmCache = {};
  const out = [];
  for (const s of all) {
    const members = (await db.prepare("SELECT u.id, u.name, u.email, u.picture, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.added_at").bind(s.id).all()).results;
    let firm = null;
    if (s.firm_id) {
      if (!firmCache[s.firm_id]) {
        const f = await getSpace(db, s.firm_id);
        const staff = f ? (await db.prepare("SELECT u.id, u.name, u.email, u.picture FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? AND m.role IN ('owner','editor')").bind(f.id).all()).results : [];
        firmCache[s.firm_id] = f ? { id: f.id, name: f.name, profile: prof(f), staff } : null;
      }
      firm = firmCache[s.firm_id];
    }
    const showEmail = ["owner", "editor", "firm"].includes(s.role);
    out.push({ id: s.id, kind: s.kind, name: s.name, ubn: s.ubn || "", role: s.role, viaFirm: !direct.some(d => d.id === s.id),
      profile: s.kind === "firm" ? prof(s) : undefined, firm,
      members: members.map(m => ({ id: m.id, name: m.name, picture: m.picture, role: m.role, email: showEmail ? m.email : undefined })) });
  }
  return json({ user: u, spaces: out });
}

export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const db = env.DB, u = await currentUser(request, db); if (!u) return json({ error: "請先登入" }, 401);
  let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const now = Date.now();

  if (b.action === "create") {
    const name = cleanName(b.name); if (!name) return json({ error: "請輸入名稱" }, 400);
    if (b.kind === "company") return json({ space: await createCompany(db, u, { name, ubn: cleanUbn(b.ubn) }) });
    if (b.kind === "firm") {
      const id = newId("f-");
      await db.batch([
        db.prepare("INSERT INTO spaces (id, kind, name, ubn, owner_id, profile, created_at, updated_at) VALUES (?, 'firm', ?, ?, ?, ?, ?, ?)")
          .bind(id, name, cleanUbn(b.ubn), u.id, JSON.stringify(cleanProfile(b.profile)), now, now),
        db.prepare("INSERT INTO members (space_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)").bind(id, u.id, now),
      ]);
      return json({ space: id });
    }
    return json({ error: "bad kind" }, 400);
  }

  const s = await getSpace(db, String(b.space || "")); const role = await roleIn(db, u.id, s);
  if (!s || !role) return json({ error: "找不到這個帳本" }, 404);

  switch (b.action) {
    case "update": {
      if (role !== "owner" || s.kind === "personal") return json({ error: "只有負責人可以修改" }, 403);
      const name = cleanName(b.name) || s.name;
      await db.prepare("UPDATE spaces SET name = ?, ubn = ?, profile = ?, updated_at = ? WHERE id = ?")
        .bind(name, cleanUbn(b.ubn), s.kind === "firm" ? JSON.stringify(cleanProfile(b.profile)) : s.profile, now, s.id).run();
      return json({ ok: true });
    }
    case "setRole": {
      if (role !== "owner") return json({ error: "只有負責人可以調整成員" }, 403);
      const r = String(b.role); if (!ROLES.includes(r) || r === "owner") return json({ error: "bad role" }, 400);
      if (s.kind === "firm" && r === "submitter") return json({ error: "bad role" }, 400);
      if (b.user === u.id) return json({ error: "不能調整自己的角色" }, 400);
      await db.prepare("UPDATE members SET role = ? WHERE space_id = ? AND user_id = ? AND role != 'owner'").bind(r, s.id, String(b.user)).run();
      return json({ ok: true });
    }
    case "remove": {
      if (role !== "owner") return json({ error: "只有負責人可以移除成員" }, 403);
      if (b.user === u.id) return json({ error: "負責人不能移除自己" }, 400);
      await db.prepare("DELETE FROM members WHERE space_id = ? AND user_id = ? AND role != 'owner'").bind(s.id, String(b.user)).run();
      return json({ ok: true });
    }
    case "leave": {
      if (role === "owner") return json({ error: "負責人不能退出，請先刪除帳本" }, 400);
      await db.prepare("DELETE FROM members WHERE space_id = ? AND user_id = ?").bind(s.id, u.id).run();
      return json({ ok: true });
    }
    case "unlinkFirm": {
      // the company owner can stop sharing with the firm; the firm can also release a client
      const firmSide = role === "firm" && s.kind === "company";
      if (!(role === "owner" && s.kind === "company") && !firmSide) return json({ error: "沒有權限" }, 403);
      await db.prepare("UPDATE spaces SET firm_id = NULL, updated_at = ? WHERE id = ?").bind(now, s.id).run();
      return json({ ok: true });
    }
    case "deleteSpace": {
      if (role !== "owner" || s.kind === "personal") return json({ error: "只有負責人可以刪除" }, 403);
      await db.batch([
        db.prepare("DELETE FROM items WHERE space_id = ?").bind(s.id),
        db.prepare("DELETE FROM history WHERE space_id = ?").bind(s.id),
        db.prepare("DELETE FROM invites WHERE space_id = ?").bind(s.id),
        db.prepare("DELETE FROM members WHERE space_id = ?").bind(s.id),
        db.prepare("UPDATE spaces SET firm_id = NULL WHERE firm_id = ?").bind(s.id),
        db.prepare("DELETE FROM spaces WHERE id = ?").bind(s.id),
      ]);
      return json({ ok: true });
    }
  }
  return json({ error: "unknown action" }, 400);
}
