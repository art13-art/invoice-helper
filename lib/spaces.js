// Who may do what in a space. A space is a personal ledger, a company ledger shared by its members,
// or a 記帳士事務所 (firm) whose staff can work on every company linked to it.
//
// Effective roles in a company space:
//   owner      老闆：everything, manages members, links/unlinks the firm
//   editor     記帳人員：all entries, books, recurring rules
//   submitter  報帳人員：sees and edits only the entries they created
//   viewer     檢視者：read only
//   firm       事務所人員（owner/editor of the linked firm）：all entries, comments, locks periods
export const ROLES = ["owner", "editor", "submitter", "viewer"];
export const ROLE_NAME = { owner: "負責人", editor: "記帳人員", submitter: "報帳人員", viewer: "檢視者", firm: "記帳士事務所" };

export const newId = (p = "") => p + Date.now().toString(36) + crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 10);

export async function getSpace(db, id) {
  return db.prepare("SELECT * FROM spaces WHERE id = ?").bind(id).first();
}

/* The user's effective role in a space, or null when they have no access. */
export async function roleIn(db, userId, space) {
  if (!space) return null;
  const m = await db.prepare("SELECT role FROM members WHERE space_id = ? AND user_id = ?").bind(space.id, userId).first();
  if (m) return m.role;
  if (space.kind === "company" && space.firm_id) {
    const f = await db.prepare("SELECT role FROM members WHERE space_id = ? AND user_id = ?").bind(space.firm_id, userId).first();
    if (f && (f.role === "owner" || f.role === "editor")) return "firm";
    if (f && f.role === "viewer") return "viewer";
  }
  return null;
}

export const canWrite = r => r === "owner" || r === "editor" || r === "firm";
export const canLock = (r, space) => r === "firm" || (r === "owner" && !space.firm_id) || (space.kind === "personal" && r === "owner");

/* Make sure every user has a personal space; returns its id. */
export async function ensurePersonal(db, user) {
  const row = await db.prepare("SELECT s.id FROM spaces s JOIN members m ON m.space_id = s.id WHERE s.kind = 'personal' AND m.user_id = ?").bind(user.id).first();
  if (row) return row.id;
  const id = newId("p-"), now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO spaces (id, kind, name, owner_id, created_at, updated_at) VALUES (?, 'personal', ?, ?, ?, ?)").bind(id, "個人", user.id, now, now),
    db.prepare("INSERT INTO members (space_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, now),
  ]);
  return id;
}

/* Create a company space with one book, owned by the user. */
export async function createCompany(db, user, { name, ubn, firmId }) {
  const id = newId("c-"), now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO spaces (id, kind, name, ubn, owner_id, firm_id, created_at, updated_at) VALUES (?, 'company', ?, ?, ?, ?, ?, ?)")
      .bind(id, name, ubn || "", user.id, firmId || null, now, now),
    db.prepare("INSERT INTO members (space_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, now),
    db.prepare("INSERT INTO items (space_id, id, kind, data, updated_at, deleted, srv, created_by, updated_by) VALUES (?, 'main', 'book', ?, ?, 0, ?, ?, ?)")
      .bind(id, JSON.stringify({ kind: "biz", name, ubn: ubn || "", order: 0 }), now, now, user.id, user.id),
  ]);
  return id;
}

export const cleanName = s => String(s || "").replace(/[<>]/g, "").trim().slice(0, 40);
export const cleanUbn = s => (/^\d{8}$/.test(String(s || "")) ? String(s) : "");
export function cleanProfile(p) {
  const o = {};
  for (const k of ["phone", "line", "email", "address", "web", "intro"]) if (p && p[k]) o[k] = String(p[k]).replace(/[<>]/g, "").trim().slice(0, k === "intro" ? 200 : 80);
  return o;
}
