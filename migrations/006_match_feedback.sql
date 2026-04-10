CREATE TABLE IF NOT EXISTS match_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  contacted INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(match_id, user_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_match_feedback_match_user
ON match_feedback(match_id, user_id);

CREATE INDEX IF NOT EXISTS idx_match_feedback_created
ON match_feedback(created_at DESC, id DESC);
