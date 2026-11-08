CREATE TABLE IF NOT EXISTS links (
  code       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0
);
