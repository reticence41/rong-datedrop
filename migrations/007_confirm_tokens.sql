CREATE TABLE IF NOT EXISTS confirm_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  action TEXT NOT NULL,
  user_id INTEGER,
  admin_key_prefix TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_confirm_tokens_action_expires
ON confirm_tokens(action, expires_at, used_at);
