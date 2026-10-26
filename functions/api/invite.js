// Invite links.
//   GET  /api/invite?t=TOKEN          → public preview: who invites, for what (used by /join/)
//   GET  /api/invite?space=FIRM       → the firm's current client referral link (signed in, firm staff)
//   POST /api/invite { action:"create", space, kind:"member"|"client", role }
//   POST /api/invite { action:"accept", t, name, ubn }   → join a company/firm, or (client link) create a company linked to the firm
//   POST /api/invite { action:"revoke", space, kind }
import { json, currentUser, sameSite, sha256 } from "../../lib/auth.js";
import { getSpace, roleIn, createCompany, cleanName, cleanUbn, ROLES, ROLE_NAME } from "../../lib/spaces.js";

const DAY = 86400e3;
const rand = () => [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
// Client referral links are meant to be printed and shared publicly, so they are stored readable ("pub:" prefix);
// member invites are stored only as a hash.
async function findInvite(db, t) {
  if (!/^[a-f0-9]{36}$/.test(t || "")) return null;
  return db.prepare("SELECT * FROM invites WHERE (token = ? OR token = ?) AND revoked = 0").bind(await sha256(t), "pub:" + t).first();
}
const origin = req => new URL(req.url).origin;
const prof = s => { try { return JSON.parse(s.profile || "{}"); } catch { return {}; } };

export async function onRequestGet({ request, env }) {
  const db = env.DB, q = new URL(request.url).searchParams;
  if (q.get("space")) {
    const u = await currentUser(request, db); if (!u) return json({ error: "請先登入" }, 401);
    const s = await getSpace(db, q.get("space")); const m = s && await db.prepare("SELECT role FROM members WHERE space_id = ? AND user_id = ?").bind(s.id, u.id).first();
    if (!s || s.kind !== "firm" || !m || !["owner", "editor"].includes(m.role)) return json({ error: "沒有權限" }, 403);
    const inv = await db.prepare("SELECT token FROM invites WHERE space_id = ? AND kind = 'client' AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC").bind(s.id, Date.now()).first();
    return json({ url: inv ? `${origin(request)}/join/?t=${inv.token.slice(4)}` : null });
  }
  const inv = await findInvite(db, q.get("t"));
  if (!inv || inv.expires_at < Date.now() || (inv.max_uses && inv.uses >= inv.max_uses)) return json({ error: "這個邀請連結已經失效，請向對方要一個新的" }, 404);
  const s = await getSpace(db, inv.space_id); if (!s) return json({ error: "邀請的帳本已經不存在" }, 404);
  const firm = s.kind === "firm" ? s : s.firm_id ? await getSpace(db, s.firm_id) : null;
  return json({ kind: inv.kind, role: inv.role, roleName: ROLE_NAME[inv.role] || "",
    space: { name: s.name, kind: s.kind }, firm: firm ? { name: firm.name, profile: prof(firm) } : null });
}

export async function onRequestPost({ request, env }) {
  if (!sameSite(request)) return json({ error: "forbidden" }, 403);
  const db = env.DB, u = await currentUser(request, db); if (!u) return json({ error: "請先登入" }, 401);
  let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const now = Date.now();

  if (b.action === "create" || b.action === "revoke") {
    const s = await getSpace(db, String(b.space || "")); const role = await roleIn(db, u.id, s);
    if (!s || !role) return json({ error: "找不到這個帳本" }, 404);
    const kind = b.kind === "client" ? "client" : "member";
    if (kind === "client" && !(s.kind === "firm" && ["owner", "editor"].includes(role))) return json({ error: "只有事務所可以邀請客戶" }, 403);
    if (kind === "member" && (role !== "owner" || s.kind === "personal")) return json({ error: "只有負責人可以邀請成員" }, 403);
    if (b.action === "revoke") {
      await db.prepare("UPDATE invites SET revoked = 1 WHERE space_id = ? AND kind = ?").bind(s.id, kind).run();
      return json({ ok: true });
    }
    let r = null;
    if (kind === "member") {
      r = String(b.role || "editor");
      if (!ROLES.includes(r) || r === "owner" || (s.kind === "firm" && r === "submitter")) return json({ error: "bad role" }, 400);
    } else {
      await db.prepare("UPDATE invites SET revoked = 1 WHERE space_id = ? AND kind = 'client'").bind(s.id).run();
    }
    const t = rand();
    await db.prepare("INSERT INTO invites (token, space_id, kind, role, created_by, created_at, expires_at, uses, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)")
      .bind(kind === "client" ? "pub:" + t : await sha256(t), s.id, kind, r, u.id, now, now + (kind === "client" ? 3650 : 7) * DAY, kind === "client" ? null : 20).run();
    return json({ url: `${origin(request)}/join/?t=${t}`, expires: now + (kind === "client" ? 3650 : 7) * DAY });
  }

  if (b.action === "accept") {
    const inv = await findInvite(db, b.t);
    if (!inv || inv.expires_at < now || (inv.max_uses && inv.uses >= inv.max_uses)) return json({ error: "這個邀請連結已經失效，請向對方要一個新的" }, 404);
    const s = await getSpace(db, inv.space_id); if (!s) return json({ error: "邀請的帳本已經不存在" }, 404);
    if (inv.kind === "client") {
      // link a company the user already owns, or create a new one
      if (b.link) {
        const c = await getSpace(db, String(b.link));
        const own = c && c.kind === "company" && await db.prepare("SELECT 1 FROM members WHERE space_id = ? AND user_id = ? AND role = 'owner'").bind(c.id, u.id).first();
        if (!own) return json({ error: "只能連結你是負責人的公司帳本" }, 403);
        await db.batch([
          db.prepare("UPDATE spaces SET firm_id = ?, updated_at = ? WHERE id = ?").bind(s.id, now, c.id),
          db.prepare("UPDATE invites SET uses = uses + 1 WHERE token = ?").bind(inv.token),
        ]);
        return json({ space: c.id });
      }
      const name = cleanName(b.name); if (!name) return json({ error: "請輸入公司或工作室名稱" }, 400);
      const id = await createCompany(db, u, { name, ubn: cleanUbn(b.ubn), firmId: s.id });
      await db.prepare("UPDATE invites SET uses = uses + 1 WHERE token = ?").bind(inv.token).run();
      return json({ space: id });
    }
    const existing = await db.prepare("SELECT role FROM members WHERE space_id = ? AND user_id = ?").bind(s.id, u.id).first();
    if (!existing) {
      await db.batch([
        db.prepare("INSERT INTO members (space_id, user_id, role, added_at) VALUES (?, ?, ?, ?)").bind(s.id, u.id, inv.role, now),
        db.prepare("UPDATE invites SET uses = uses + 1 WHERE token = ?").bind(inv.token),
      ]);
    }
    return json({ space: s.id, kind: s.kind, already: !!existing });
  }
  return json({ error: "unknown action" }, 400);
}
