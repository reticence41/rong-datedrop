ALTER TABLE users ADD COLUMN university TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_university ON users(university);
