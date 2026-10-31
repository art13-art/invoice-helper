-- 報稅帳本 database (Cloudflare D1). Apply with the D1 console or `wrangler d1 execute taxtools-ledger --file db/schema.sql`.
-- A "space" holds books and entries: one personal space per user, company spaces shared by members,
-- and firm spaces (記帳士事務所) whose members can work on every company linked to the firm.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, picture TEXT, created_at INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- personal | company | firm
  name TEXT NOT NULL,
  ubn TEXT,
  owner_id TEXT NOT NULL,
  firm_id TEXT,                       -- company → the firm that keeps its books
  profile TEXT,                       -- JSON: firm phone/line/address/intro, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_firm ON spaces(firm_id);

CREATE TABLE IF NOT EXISTS members (
  space_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- owner | editor | submitter | viewer
  added_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,             -- sha256 of the link token
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- member | client
  role TEXT,                          -- for member invites
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,                   -- NULL = unlimited (firm referral link)
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invites_space ON invites(space_id);

DROP TABLE IF EXISTS items;
CREATE TABLE items (
  space_id TEXT NOT NULL, id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- book | entry | recur | comment | lock | pref
  data TEXT,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  srv INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT,
  PRIMARY KEY (space_id, id)
);
CREATE INDEX IF NOT EXISTS items_sync ON items(space_id, srv);

CREATE TABLE IF NOT EXISTS history (
  space_id TEXT NOT NULL, item_id TEXT NOT NULL, at INTEGER NOT NULL, user_id TEXT,
  action TEXT NOT NULL,               -- create | update | delete
  before TEXT, after TEXT
);
CREATE INDEX IF NOT EXISTS history_item ON history(space_id, item_id, at);

-- 網站流量（不用 Cookie、不存 IP；每日訪客只存當天加鹽雜湊，90 天後刪除）與意見回饋
CREATE TABLE IF NOT EXISTS stat_views (day TEXT NOT NULL, path TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path));
CREATE TABLE IF NOT EXISTS stat_refs (day TEXT NOT NULL, ref TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ref));
-- 廣告來源：網址帶 utm_source／utm_campaign（或 Google 廣告的 gclid）進站的次數
CREATE TABLE IF NOT EXISTS stat_utm (day TEXT NOT NULL, src TEXT NOT NULL, camp TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, src, camp));
-- 轉換事件（例如送出詢問表單），src＝這次造訪的來源（utm、來源網站或 direct）
CREATE TABLE IF NOT EXISTS stat_events (day TEXT NOT NULL, ev TEXT NOT NULL, src TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ev, src));
CREATE TABLE IF NOT EXISTS stat_devs (day TEXT NOT NULL, dev TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, dev));
CREATE TABLE IF NOT EXISTS stat_visitors (day TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (day, h));
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, page TEXT, kind TEXT, text TEXT NOT NULL, contact TEXT,
  user_id TEXT, iph TEXT, status TEXT NOT NULL DEFAULT 'new', note TEXT);
CREATE INDEX IF NOT EXISTS feedback_ts ON feedback(ts);
-- 每一頁從哪個外部網站進來（只記有外部來源的瀏覽）
CREATE TABLE IF NOT EXISTS stat_page_refs (day TEXT NOT NULL, path TEXT NOT NULL, ref TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path, ref));
