-- Store AI-generated narrative match reports for frontend display
ALTER TABLE matches ADD COLUMN narrative TEXT DEFAULT NULL;
