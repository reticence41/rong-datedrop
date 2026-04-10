CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_users_student_id ON users(student_id);
CREATE INDEX IF NOT EXISTS idx_matches_week_user ON matches(week_key, user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_opt_ins_week ON opt_ins(week_key, status);

