-- Schema for the WebSocket chat server.
--
-- Apply with:
--   psql "$DATABASE_URL" -f server/schema.sql
--
-- Migrations are version-controlled and idempotent so a fresh environment and
-- an existing one converge on the same shape.

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active_tokens (
    id         SERIAL PRIMARY KEY,
    token      VARCHAR(255) UNIQUE NOT NULL,
    username   VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- One active session per user.
--
-- Login upserts on this constraint so a re-login replaces the previous session
-- instead of failing on the UNIQUE(token) violation that two same-second
-- logins would otherwise cause. Without this index the ON CONFLICT clause has
-- nothing to match and Postgres errors.
CREATE UNIQUE INDEX IF NOT EXISTS active_tokens_username_key
    ON active_tokens (username);

-- Supports the revocation sweep: expired sessions are cleared by age.
CREATE INDEX IF NOT EXISTS active_tokens_created_at_idx
    ON active_tokens (created_at);
