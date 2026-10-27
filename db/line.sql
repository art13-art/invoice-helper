-- LINE 群組助理用的資料表（與網站帳本資料表分開，可重複執行）。
-- chat_id：群組 ID（C…）、多人聊天 ID（R…）或個人 ID（U…）。
CREATE TABLE IF NOT EXISTS line_kv (k TEXT PRIMARY KEY, v TEXT);                        -- 早報設定、用量計數
CREATE TABLE IF NOT EXISTS line_history (                                                -- 和助理的對話（讓它記得上下文）
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_history_chat ON line_history(chat_id, id);
CREATE TABLE IF NOT EXISTS line_msgs (                                                   -- 群組訊息紀錄（做總結用，保留 30 天）
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, user_id TEXT, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, media TEXT);
CREATE INDEX IF NOT EXISTS line_msgs_chat ON line_msgs(chat_id, ts);
CREATE TABLE IF NOT EXISTS line_members (                                                -- 群組成員名稱、是否拒絕被記錄
  chat_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, optout INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS line_todos (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, task TEXT NOT NULL, assignee_id TEXT, assignee_name TEXT, due INTEGER,
  status TEXT NOT NULL, created INTEGER NOT NULL, created_by TEXT);
CREATE INDEX IF NOT EXISTS line_todos_chat ON line_todos(chat_id, status);
CREATE TABLE IF NOT EXISTS line_reminders (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, due INTEGER NOT NULL, text TEXT NOT NULL, repeat TEXT NOT NULL DEFAULT 'none',
  mention_id TEXT, mention_name TEXT, todo_id TEXT, created INTEGER NOT NULL, created_by TEXT, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS line_reminders_due ON line_reminders(status, due);
CREATE TABLE IF NOT EXISTS line_events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);       -- 避免 LINE 重送時重複處理
CREATE TABLE IF NOT EXISTS line_pending (                                                -- 等人按「確認」才寫入的帳
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL,
  created INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS line_books (                                                  -- 廠商群組綁定的雲端記帳表
  chat_id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, url TEXT, name TEXT, tab TEXT, headers TEXT, created_by TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS line_usage (                                                  -- AI token 用量與費用、LINE 主動訊息
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, chat_id TEXT, user_id TEXT,
  model TEXT, input INTEGER DEFAULT 0, output INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
  recipients INTEGER DEFAULT 0, usd REAL DEFAULT 0);
CREATE INDEX IF NOT EXISTS line_usage_month ON line_usage(month, kind);
CREATE TABLE IF NOT EXISTS line_reports (month TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);   -- 每月開銷報表
CREATE TABLE IF NOT EXISTS line_memory (                                                 -- 大家教小助理的事：chat_id 空＝所有群組（管理員教的），有值＝只用在那個聊天室
  id TEXT PRIMARY KEY, text TEXT NOT NULL, created_by TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, chat_id TEXT);
-- 舊資料庫補欄位（2026-10-27 已在正式環境執行）：ALTER TABLE line_memory ADD COLUMN chat_id TEXT;

-- 訂單流程：監看來源表（客服表）每一列的處理狀態
CREATE TABLE IF NOT EXISTS line_flow_rows (
  flow TEXT NOT NULL, row INTEGER NOT NULL, hash TEXT, first_seen INTEGER, status TEXT, ts INTEGER, dst_row INTEGER, sent_at INTEGER, acked INTEGER DEFAULT 0, nudged INTEGER DEFAULT 0,
  PRIMARY KEY (flow, row)
);

-- 每個群組每天的重點摘要（保留一年，原始訊息只留 30 天）
CREATE TABLE IF NOT EXISTS line_digests (
  chat_id TEXT NOT NULL, day TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY (chat_id, day)
);
