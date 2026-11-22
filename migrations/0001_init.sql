-- Single-row table holding the whole sync state as JSON.
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Single-row lock so overlapping cron runs never sync concurrently.
CREATE TABLE IF NOT EXISTS sync_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_until INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_lock (id, locked_until) VALUES (1, 0);
