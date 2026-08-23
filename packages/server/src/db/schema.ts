export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  avatar_emoji TEXT NOT NULL DEFAULT '🤖', model_tier TEXT NOT NULL DEFAULT 'sonnet',
  pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  notifications INTEGER NOT NULL DEFAULT 1, session_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle', attention TEXT NOT NULL DEFAULT 'none',
  thread_id TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group')),
  title TEXT NOT NULL DEFAULT '', member_bot_ids TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  last_read_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('user','bot','system')),
  author_bot_id TEXT, reply_to_id TEXT, content_md TEXT NOT NULL DEFAULT '',
  cards TEXT NOT NULL DEFAULT '[]', streaming INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, message_id TEXT, path TEXT NOT NULL, name TEXT NOT NULL,
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, input_summary TEXT NOT NULL, raw_input TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','allowed','denied','expired')),
  decided_by TEXT CHECK(decided_by IN ('user','rule','auto_review')),
  reason TEXT NOT NULL DEFAULT '', rule_id TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('require','allow')),
  tool_pattern TEXT NOT NULL DEFAULT '*', input_pattern TEXT NOT NULL DEFAULT '',
  scope_note TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','taught','imported')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_skills (
  bot_id TEXT NOT NULL, skill_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bot_id, skill_id)
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL,
  cron_expr TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC',
  instruction_md TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER, next_run_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routines_bot ON routines(bot_id);
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  finished_at INTEGER, status TEXT NOT NULL CHECK(status IN ('running','ok','failed','interrupted')),
  summary TEXT NOT NULL DEFAULT '', thread_id TEXT, is_test INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_routine ON routine_runs(routine_id, started_at DESC);
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY, from_bot_id TEXT NOT NULL, to_bot_id TEXT NOT NULL,
  content_md TEXT NOT NULL, hops INTEGER NOT NULL DEFAULT 1,
  delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cost_estimate REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content_md, content='messages', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_md) VALUES (new.rowid, new.content_md);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_md) VALUES('delete', old.rowid, old.content_md);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_md) VALUES('delete', old.rowid, old.content_md);
  INSERT INTO messages_fts(rowid, content_md) VALUES (new.rowid, new.content_md);
END;
`;
