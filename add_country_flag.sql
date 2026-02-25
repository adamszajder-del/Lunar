-- Migration: Add country_flag column to users table
-- Run this migration before deploying the new version
-- Safe to run multiple times (IF NOT EXISTS)

ALTER TABLE users ADD COLUMN IF NOT EXISTS country_flag VARCHAR(2);

-- Index for potential future queries by country
CREATE INDEX IF NOT EXISTS idx_users_country_flag ON users(country_flag) WHERE country_flag IS NOT NULL;
