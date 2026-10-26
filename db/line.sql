-- LINE 個人助理用的資料表（與帳本資料表分開，可重複執行）。
CREATE TABLE IF NOT EXISTS line_kv (k TEXT PRIMARY KEY, v TEXT);                 -- owner、早報設定等
CREATE TABLE IF NOT EXISTS line_history (                                         -- 最近的對話，讓助理記得上下文
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_history_user ON line_history(user_id, id);
CREATE TABLE IF NOT EXISTS line_pending (                                         -- 等你按「確認」才執行的動作
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL,
  created INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS line_reminders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, due INTEGER NOT NULL, text TEXT NOT NULL, repeat TEXT NOT NULL DEFAULT 'none',
  created INTEGER NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS line_reminders_due ON line_reminders(status, due);
CREATE TABLE IF NOT EXISTS line_events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);   -- 避免 LINE 重送時重複處理
