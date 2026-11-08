-- 短链主表
CREATE TABLE IF NOT EXISTS links (
  code       TEXT    PRIMARY KEY,
  url        TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0
);

-- 列表按创建时间倒序查询
CREATE INDEX IF NOT EXISTS idx_links_created_at ON links (created_at DESC);
