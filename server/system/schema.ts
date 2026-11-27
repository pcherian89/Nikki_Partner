/**
 * Phase 0 foundation tables. Additive only: nothing here changes or drops an existing table, so older code keeps
 * working on a migrated database and the pre-upgrade snapshot (db.ts) can always be put back.
 *
 * These tables hold system state (sessions, jobs, approvals, the activity log, AI spend, notifications), not the
 * user's planning data, so they are deliberately NOT in `TABLES` (export/import) — an export never carries session
 * hashes, credentials or approval records.
 */
export const SYSTEM_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  verified_at TEXT,
  second_factor INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  confidential INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  ai_allowed INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  account_hint TEXT,
  space_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  credential_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent_id, started_at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  system INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  catch_up TEXT NOT NULL DEFAULT 'once',
  last_status TEXT,
  last_error TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(enabled, next_run_at);
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job_id, started_at);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  space_id TEXT NOT NULL,
  agent_id TEXT,
  level TEXT NOT NULL,
  params TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  approved_hash TEXT,
  approval_valid_until TEXT,
  approved_by_session TEXT,
  execute_after TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS actions_status ON actions(status, created_at);
CREATE TABLE IF NOT EXISTS activity_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  space_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS activity_log_no_update BEFORE UPDATE ON activity_log BEGIN SELECT RAISE(ABORT, 'The activity log is append-only.'); END;
CREATE TRIGGER IF NOT EXISTS activity_log_no_delete BEFORE DELETE ON activity_log BEGIN SELECT RAISE(ABORT, 'The activity log is append-only.'); END;
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  month TEXT NOT NULL,
  day TEXT NOT NULL,
  workflow TEXT NOT NULL,
  agent_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_month ON ai_usage(month, day);
CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  month TEXT NOT NULL,
  day TEXT NOT NULL,
  workflow TEXT NOT NULL,
  agent_id TEXT,
  amount_usd REAL NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sensitive INTEGER NOT NULL DEFAULT 0,
  link TEXT,
  space_id TEXT,
  dedupe_key TEXT UNIQUE,
  read_at TEXT,
  push_status TEXT NOT NULL DEFAULT 'none',
  push_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at);
`;

/** Tables cleared by "Delete my data" in addition to the planning tables. Sessions, the activity log, AI spend and
 *  system jobs are kept: they are needed for security and for the budget, and the log records ids only. */
export const SYSTEM_WIPE_TABLES = ["notifications", "actions", "agent_runs", "job_runs"];
