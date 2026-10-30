/**
 * App-wide configuration, loaded once from environment variables at boot.
 * `loadConfig` throws synchronously — crashing boot rather than serving
 * traffic in a half-configured state — if `DATABASE_URL` is missing, or if
 * `SETTLEMENT_INTERNAL_TOKEN` is missing while `nodeEnv === 'production'`.
 *
 * Later sub-phases add their own fields to this same interface/loader
 * rather than introducing a second config system.
 */
export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;

  pgPoolMax: number;
  /** Proxy hops in front of the api whose X-Forwarded-For entries are trusted; 0 trusts none. */
  trustProxyHops: number;
  pgPoolMin: number;
  pgPoolIdleTimeoutMs: number;
  pgPoolConnectionTimeoutMs: number;

  sessionTtlHours: number;
  pendingSessionTtlMinutes: number;
  otpTtlMinutes: number;
  otpCodeLength: number;
  otpMaxAttempts: number;
  otpDevExpose: boolean;
  /** Lowercased email domains whose login code is returned in the response
   *  even when `otpDevExpose` is off: the seeded demo accounts on the hosted
   *  box, which has no email or SMS provider to deliver a code. */
  otpExposeEmailDomains: string[];

  argon2MemoryKib: number;
  argon2TimeCost: number;
  argon2Parallelism: number;

  kycUploadDir: string;
  kycMaxFileSizeBytes: number;

  acquirerLatencyMinMs: number;
  acquirerLatencyMaxMs: number;
  acquirerFailureRate: number;
  acquirerRngSeed: number | null;

  cookieName: string;
  cookieSecure: boolean;

  /** Cookie carrying an `admin_sessions` token. A completely separate name,
   *  table, and code path from `cookieName`/`sessions` — `requireAdminSession`
   *  reads only this one and `requireMerchantAuth` never reads it at all, so
   *  an admin session can never be resolved as merchant authority. */
  adminCookieName: string;
  /** Deliberately shorter than a merchant session's 12h — a minor extra
   *  caution for the higher-privilege plane. */
  adminSessionTtlHours: number;
  adminPendingSessionTtlMinutes: number;
  adminOtpTtlMinutes: number;
  adminOtpCodeLength: number;
  adminOtpMaxAttempts: number;

  /** Cookie carrying an `admin_impersonation_grants` token — the third,
   *  distinct cookie in the system. Read only by `requireMerchantAuth`, and
   *  never by `requireAdminSession`: the privilege drop is structural, not a
   *  flag that could fail to be cleared. */
  impersonationCookieName: string;
  /** Bounded lifetime of a "view as merchant" grant. Checked on every
   *  lookup — there is no "until logout" path. */
  impersonationTtlMinutes: number;

  /** Base URL of apps/settlement's internal HTTP server, reachable only
   *  inside the compose network. The API delegates settlement operations
   *  (batch runs, balance refreshes) through this. */
  settlementInternalUrl: string;
  /** Bearer token for that internal server. Required in production, same
   *  posture the retired `internalApiToken` had. */
  settlementInternalToken: string;
  /** Timeout for an internal settlement call. Generous on purpose: a full
   *  daily batch across every merchant genuinely takes longer than a typical
   *  API-latency budget. */
  settlementInternalRequestTimeoutMs: number;

  /** Redis for the dashboard read cache. Unset means no cache: every read
   *  goes to the database, which is also what happens while Redis is down. */
  redisUrl: string | undefined;

  /** Base URL of apps/web's hosted checkout, used only to build the
   *  convenience `url` field on a created payment link — the API itself
   *  has no other reason to know where apps/web is hosted, and no route
   *  redirects there. Default matches Vite's own default dev port. */
  checkoutBaseUrl: string;
  /** Browser origins allowed to call the API cross-origin with credentials,
   *  from comma-separated CORS_ALLOWED_ORIGINS. Empty in production unless
   *  set, so no production URL is baked into the code. */
  corsAllowedOrigins: string[];
  /** How long a payment link stays 'reserved' (claimed by an in-flight pay
   *  attempt) before it self-expires back to claimable, closing the gap
   *  between claim and finalize without a sweep job. */
  paymentLinkReservationTimeoutSeconds: number;

  /** Base64-encoded 32 raw bytes, the single application-level AES-256-GCM
   *  key `webhooks/secretCrypto.ts` uses to encrypt/decrypt
   *  `webhook_endpoints.secret_ciphertext`. Required in every environment
   *  (not just production) — the platform must be able to actually encrypt
   *  and later recover a webhook secret's plaintext at send time, so there
   *  is no "dev doesn't need this" story the way there is for
   *  `settlementInternalToken`. `loadConfig` decodes and validates the length,
   *  failing boot on a missing or malformed value rather than accepting
   *  garbage and failing later at first-delivery time. Callers pass
   *  `Buffer.from(config.webhookSecretEncryptionKey, "base64")` to
   *  `encryptSecret`/`decryptSecret`, which take a `Buffer` key. */
  webhookSecretEncryptionKey: string;
  /** Base64 of 32 bytes, the HMAC key for request hashes that carry card
   *  data (payments/authorize.ts). Keyed so a stored hash cannot be
   *  brute-forced back to a card number. Required in production; dev and
   *  test fall back to a fixed key, as webhookSecretEncryptionKey does. */
  cardFingerprintKey: string;
  /** Terminal-failure threshold for a single webhook_deliveries row — the
   *  attempt at which status flips from 'pending' to 'exhausted' instead of
   *  scheduling another retry. */
  webhookMaxAttempts: number;
  /** Exponential backoff base (attempt 1's delay), milliseconds. */
  webhookBackoffBaseMs: number;
  /** Exponential backoff cap — no retry ever waits longer than this,
   *  milliseconds. */
  webhookBackoffCapMs: number;
  /** How often the dispatcher's poll-fallback timer runs a dispatch pass,
   *  independent of LISTEN/NOTIFY — the safety net that guarantees no event
   *  is stuck forever even if a NOTIFY is missed. */
  webhookPollIntervalMs: number;
  /** Off on the second api replica, so one process holds the webhook LISTEN session and poll timer. */
  webhookDispatcherEnabled: boolean;
  /** Per-delivery-attempt HTTP timeout passed to the transport, milliseconds. */
  webhookRequestTimeoutMs: number;
  /** Allow webhook URLs and deliveries to loopback/private/link-local addresses. Local dev and tests only; default false. */
  webhookAllowPrivateTargets: boolean;

  /** Shared secret the acquirer signs its async callbacks with
   *  (routes/acquirerCallbacks.ts). Platform-level, not per-merchant —
   *  unlike webhookSecretEncryptionKey, there is exactly one acquirer
   *  relationship, not one secret per registered endpoint. */
  acquirerCallbackSigningSecret: string;
  /** Set true once the sandbox signs everything. */
  acquirerCallbackRequireSignature: boolean;
}

function parseNodeEnv(value: string | undefined): Config["nodeEnv"] {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }
  return "development";
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`loadConfig: expected an integer, got "${value}"`);
  }
  return parsed;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`loadConfig: expected a number, got "${value}"`);
  }
  return parsed;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

function parseCsvEnv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") return fallback;
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

// Guards a security check, so only an explicit "false" or "0" turns it off; a typo keeps it on.
function parseFailClosedBoolEnv(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized !== "false" && normalized !== "0";
}

const DEV_FALLBACK_WEBHOOK_KEY_B64 = "ZGV2LW9ubHktd2ViaG9vay1lbmNyeXB0aW9uLWtleSE=";
const DEV_FALLBACK_CARD_FINGERPRINT_KEY_B64 = "ZGV2LW9ubHktY2FyZC1maW5nZXJwcmludC1rZXktMzI=";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates a key env var (WEBHOOK_SECRET_ENCRYPTION_KEY, CARD_FINGERPRINT_KEY)
 *  decodes to exactly 32 raw bytes, failing fast at boot (same posture as DATABASE_URL) rather than
 *  accepting a missing/malformed key and only discovering the problem at
 *  first-delivery time. Returns the original base64 string unchanged — the
 *  Config field stays base64-encoded; callers decode to a Buffer at the
 *  point of use. */
function parseBase64Key32(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`loadConfig: ${name} environment variable is not set`);
  }
  if (!BASE64_RE.test(value)) {
    throw new Error(`loadConfig: ${name} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error(`loadConfig: ${name} must base64-decode to exactly 32 bytes, got ${decoded.length}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("loadConfig: DATABASE_URL environment variable is not set");
  }

  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  const settlementInternalToken = env.SETTLEMENT_INTERNAL_TOKEN ?? "";
  if (nodeEnv === "production" && settlementInternalToken === "") {
    throw new Error("loadConfig: SETTLEMENT_INTERNAL_TOKEN is required when NODE_ENV=production");
  }

  const acquirerCallbackSigningSecret = env.ACQUIRER_CALLBACK_SIGNING_SECRET ?? "";
  if (nodeEnv === "production" && acquirerCallbackSigningSecret === "") {
    throw new Error("loadConfig: ACQUIRER_CALLBACK_SIGNING_SECRET is required when NODE_ENV=production");
  }

  return {
    nodeEnv,
    port: parseIntEnv(env.PORT, 3000),
    databaseUrl,

    pgPoolMax: parseIntEnv(env.PG_POOL_MAX, 5),
    trustProxyHops: parseIntEnv(env.TRUST_PROXY_HOPS, 0),
    pgPoolMin: parseIntEnv(env.PG_POOL_MIN, 0),
    pgPoolIdleTimeoutMs: parseIntEnv(env.PG_POOL_IDLE_TIMEOUT_MS, 30_000),
    pgPoolConnectionTimeoutMs: parseIntEnv(env.PG_POOL_CONNECTION_TIMEOUT_MS, 5_000),

    sessionTtlHours: parseIntEnv(env.SESSION_TTL_HOURS, 12),
    pendingSessionTtlMinutes: parseIntEnv(env.PENDING_SESSION_TTL_MINUTES, 10),
    otpTtlMinutes: parseIntEnv(env.OTP_TTL_MINUTES, 5),
    otpCodeLength: parseIntEnv(env.OTP_CODE_LENGTH, 6),
    otpMaxAttempts: parseIntEnv(env.OTP_MAX_ATTEMPTS, 5),
    otpDevExpose: parseBoolEnv(env.OTP_DEV_EXPOSE, nodeEnv !== "production"),
    otpExposeEmailDomains: parseCsvEnv(env.OTP_EXPOSE_EMAIL_DOMAINS, []).map((d) => d.toLowerCase()),

    argon2MemoryKib: parseIntEnv(env.ARGON2_MEMORY_KIB, 19_456),
    argon2TimeCost: parseIntEnv(env.ARGON2_TIME_COST, 2),
    argon2Parallelism: parseIntEnv(env.ARGON2_PARALLELISM, 1),

    kycUploadDir: env.KYC_UPLOAD_DIR ?? "./data/kyc",
    kycMaxFileSizeBytes: parseIntEnv(env.KYC_MAX_FILE_SIZE_BYTES, 8_388_608),

    acquirerLatencyMinMs: parseIntEnv(env.ACQUIRER_LATENCY_MIN_MS, 100),
    acquirerLatencyMaxMs: parseIntEnv(env.ACQUIRER_LATENCY_MAX_MS, 400),
    acquirerFailureRate: parseFloatEnv(env.ACQUIRER_FAILURE_RATE, 0.02),
    acquirerRngSeed:
      env.ACQUIRER_RNG_SEED !== undefined && env.ACQUIRER_RNG_SEED !== ""
        ? parseIntEnv(env.ACQUIRER_RNG_SEED, 0)
        : null,

    cookieName: env.COOKIE_NAME ?? "fp_sid",
    cookieSecure: parseBoolEnv(env.COOKIE_SECURE, nodeEnv === "production"),

    adminCookieName: env.ADMIN_COOKIE_NAME ?? "fp_admin_sid",
    adminSessionTtlHours: parseIntEnv(env.ADMIN_SESSION_TTL_HOURS, 8),
    adminPendingSessionTtlMinutes: parseIntEnv(env.ADMIN_PENDING_SESSION_TTL_MINUTES, 10),
    adminOtpTtlMinutes: parseIntEnv(env.ADMIN_OTP_TTL_MINUTES, 5),
    adminOtpCodeLength: parseIntEnv(env.ADMIN_OTP_CODE_LENGTH, 6),
    adminOtpMaxAttempts: parseIntEnv(env.ADMIN_OTP_MAX_ATTEMPTS, 5),

    impersonationCookieName: env.IMPERSONATION_COOKIE_NAME ?? "fp_impersonation",
    impersonationTtlMinutes: parseIntEnv(env.IMPERSONATION_TTL_MINUTES, 15),

    settlementInternalUrl: env.SETTLEMENT_INTERNAL_URL ?? "http://settlement:8091",
    settlementInternalToken,
    settlementInternalRequestTimeoutMs: parseIntEnv(env.SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS, 30_000),

    redisUrl: env.REDIS_URL || undefined,

    checkoutBaseUrl: env.CHECKOUT_BASE_URL ?? "http://localhost:5173",
    corsAllowedOrigins: parseCsvEnv(env.CORS_ALLOWED_ORIGINS, nodeEnv === "production" ? [] : ["http://localhost:5173", "http://localhost:5174"]),
    paymentLinkReservationTimeoutSeconds: parseIntEnv(env.PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS, 60),

    webhookSecretEncryptionKey: parseBase64Key32(
      "WEBHOOK_SECRET_ENCRYPTION_KEY",
      env.WEBHOOK_SECRET_ENCRYPTION_KEY || (nodeEnv !== "production" ? DEV_FALLBACK_WEBHOOK_KEY_B64 : undefined),
    ),
    cardFingerprintKey: parseBase64Key32(
      "CARD_FINGERPRINT_KEY",
      env.CARD_FINGERPRINT_KEY || (nodeEnv !== "production" ? DEV_FALLBACK_CARD_FINGERPRINT_KEY_B64 : undefined),
    ),
    webhookMaxAttempts: parseIntEnv(env.WEBHOOK_MAX_ATTEMPTS, 8),
    webhookBackoffBaseMs: parseIntEnv(env.WEBHOOK_BACKOFF_BASE_MS, 30_000),
    webhookBackoffCapMs: parseIntEnv(env.WEBHOOK_BACKOFF_CAP_MS, 21_600_000),
    webhookPollIntervalMs: parseIntEnv(env.WEBHOOK_POLL_INTERVAL_MS, 5_000),
    webhookDispatcherEnabled: parseBoolEnv(env.WEBHOOK_DISPATCHER_ENABLED, true),
    webhookRequestTimeoutMs: parseIntEnv(env.WEBHOOK_REQUEST_TIMEOUT_MS, 10_000),
    webhookAllowPrivateTargets: parseBoolEnv(env.WEBHOOK_ALLOW_PRIVATE_TARGETS, false),

    acquirerCallbackSigningSecret,
    acquirerCallbackRequireSignature: parseFailClosedBoolEnv(env.ACQUIRER_CALLBACK_REQUIRE_SIGNATURE),
  };
}
