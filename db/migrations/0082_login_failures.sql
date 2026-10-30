-- Failed password logins, one row per attempt, counted in a sliding window
-- by apps/api/src/auth/loginLimit.ts. Additive only.
CREATE TABLE IF NOT EXISTS login_failures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL,
    account_key TEXT NOT NULL,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_failures_scope_key
    ON login_failures (scope, account_key, failed_at);
