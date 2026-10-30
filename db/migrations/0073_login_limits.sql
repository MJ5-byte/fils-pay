-- Login limits (merchant and admin planes). Failed password attempts are
-- recorded here so every API instance sees the same counts; see
-- apps/api/src/auth/loginLimits.ts. account_key is the merchant id plus email
-- (merchant plane) or the email (admin plane), lower-cased. Rows older than a
-- day are pruned as new failures arrive.

CREATE TABLE login_failures (
    id           BIGSERIAL PRIMARY KEY,
    plane        TEXT NOT NULL CHECK (plane IN ('merchant', 'admin')),
    account_key  TEXT NOT NULL,
    ip           TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_failures_account ON login_failures (plane, account_key, created_at);
CREATE INDEX idx_login_failures_ip ON login_failures (plane, ip, created_at);
CREATE INDEX idx_login_failures_created ON login_failures (created_at);

-- OTP challenges issued per user in the window (login and resend) are
-- counted from the challenge tables themselves.
CREATE INDEX idx_otp_challenges_user_created ON otp_challenges (merchant_user_id, created_at);
CREATE INDEX idx_admin_otp_challenges_user_created ON admin_otp_challenges (admin_user_id, created_at);
