-- Crush / "Shoot Your Shot" feature
-- Users can secretly name someone they like; mutual crushes get instant-matched.

CREATE TABLE IF NOT EXISTS crushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  target_student_id TEXT NOT NULL DEFAULT '',
  week_key TEXT NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, week_key)
);

CREATE INDEX IF NOT EXISTS idx_crushes_week ON crushes(week_key);
CREATE INDEX IF NOT EXISTS idx_crushes_target ON crushes(target_student_id, week_key);
