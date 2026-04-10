-- Icebreaker greeting messages: each user can send one message to their match
CREATE TABLE IF NOT EXISTS match_greetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_match_greetings_match ON match_greetings(match_id);
