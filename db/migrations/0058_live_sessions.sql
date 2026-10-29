-- A view over sessions that are neither revoked nor expired.

CREATE OR REPLACE VIEW live_sessions AS
SELECT id,
       merchant_user_id,
       token_hash,
       authenticated,
       created_at,
       expires_at
  FROM sessions
 WHERE revoked_at IS NULL
   AND expires_at > now()
   AND authenticated = true;
