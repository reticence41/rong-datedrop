-- Add paused flag so users can temporarily opt out of matching
ALTER TABLE users ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
