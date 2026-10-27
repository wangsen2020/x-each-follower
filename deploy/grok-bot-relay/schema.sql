-- D1 schema for the Grok Bot relay. Idempotent: safe to run repeatedly.
CREATE TABLE IF NOT EXISTS jobs (
  job_id        TEXT PRIMARY KEY,
  prompt_hash   TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('dispatching','accepted','unknown','completed','failed')),
  callback_hash TEXT NOT NULL,          -- hash of the one-time callback token
  result        TEXT,
  reason_code   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs (status, updated_at);
