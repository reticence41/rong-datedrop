-- Add confidence score to matches
ALTER TABLE matches ADD COLUMN confidence INTEGER DEFAULT NULL;
