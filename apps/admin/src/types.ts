/**
 * Hand-maintained DTO types mirroring the admin API's camelCase JSON shapes
 * — no codegen, consistent with apps/web and with this project's "no ORM,
 * no generated client" style elsewhere.
 *
 * Platform conventions throughout: camelCase JSON, `_fils`-suffixed integer
 * money fields, and a named collection key plus `nextCursor` for
 * keyset-paginated lists (see apps/api's `transactions/query.ts`).
 */

/** The uniform error body shape apps/api's error handler produces:
 *  `{ error: "code", message?: "string" }` — identical to apps/web's. */
export interface ApiErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------

export type AdminRole = "support" | "finance" | "super_admin";

/** `POST /v1/admin/auth/login` → `200 { otpRequired: true, otpExpiresAt, devOtpCode? }`. */
export interface AdminLoginResponse {
  otpRequired: boolean;
  otpExpiresAt: string;
  /** Dev-only convenience, gated server-side the same way merchant login gates it. */
  devOtpCode?: string;
}

/** `POST /v1/admin/auth/otp/verify` → `200 { authenticated: true, adminUserId, role }`. */
export interface AdminOtpVerifyResponse {
  authenticated: boolean;
  adminUserId: string;
  role: AdminRole;
}

/** `GET /v1/admin/auth/me` → `{ adminUserId, email, role }`. */
export interface AdminMe {
  adminUserId: string;
  email: string;
  role: AdminRole;
}

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

export type MerchantStatus = "active" | "suspended" | "closed";
export type MerchantOnboardingStatus = "submitted" | "under_review" | "approved" | "rejected";

/** One row of `GET /v1/admin/merchants` — the columns the list query selects. */
export interface AdminMerchantSummary {
  id: string;
  displayName: string;
  status: MerchantStatus;
  onboardingStatus: MerchantOnboardingStatus;
  kycPassed: boolean;
  mdrBps: number;
  testMode: boolean;
  createdAt: string;
}

/** Keyset `limit`/`cursor` paging, same envelope as apps/api's other
 *  lists. */
export interface AdminMerchantListResponse {
  merchants: AdminMerchantSummary[];
  nextCursor: string | null;
}

/** `merchant_business_profiles` (migration 0014), camelCased. */
export interface MerchantBusinessProfile {
  legalName: string;
  registrationNumber: string;
  businessType: string;
  country: string;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  updatedAt: string;
}

/** `merchant_kyc_reviews` (migration 0016 + 0036's `reviewer_admin_user_id`). */
export interface KycReview {
  id: string;
  outcome: "approved" | "rejected";
  reviewerIdentifier: string;
  reviewerAdminUserId: string | null;
  notes: string | null;
  reviewedAt: string;
}

/** `listApiKeys`'s `ApiKeySummary` (apps/api `apiKeys/issue.ts`), JSON-serialized. */
export interface AdminApiKeySummary {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** `webhook_endpoints` (migration 0021) — `secret_ciphertext` is never selected. */
export interface AdminWebhookEndpointSummary {
  id: string;
  url: string;
  status: "active" | "disabled";
  secretPrefix: string;
  createdAt: string;
  updatedAt: string;
}

/** `merchant_balances` (migration 0025). */
export interface MerchantBalance {
  merchantId: string;
  cachedPayableFils: number;
  lastSettlementBatchId: string | null;
  updatedAt: string;
}

/** `settlement_batches` (migration 0006 + 0024). */
export interface SettlementBatchSummary {
  id: string;
  merchantId: string;
  batchDate: string;
  status: "open" | "closed" | "paid";
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
  closedAt: string | null;
  createdAt: string;
}

/** `GET /v1/admin/merchants/:id` — the merchant plus one key per source
 *  table the detail page reads. */
export interface AdminMerchantDetail {
  merchant: AdminMerchantSummary;
  businessProfile: MerchantBusinessProfile | null;
  kycReviews: KycReview[];
  apiKeys: AdminApiKeySummary[];
  webhookEndpoints: AdminWebhookEndpointSummary[];
  balance: MerchantBalance | null;
  currentFeeSchedule: CurrentFeeScheduleDisplay | null;
  recentSettlementBatches: SettlementBatchSummary[];
}

/** `apps/api/src/fees/currentFeeScheduleDisplay.ts`'s
 *  `CurrentFeeScheduleDisplay`, JSON-serialized. Note: this is the newest
 *  *entered* schedule row for this merchant, not necessarily the one
 *  currently governing capture/settlement — see the merchant detail page's
 *  own note next to where this renders. */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: string;
  createdAt: string;
}

/** `POST /v1/admin/merchants/:id/kyc-reviews` → `recordKycReview`'s
 *  `RecordKycReviewResult` (apps/api `onboarding/review.ts`). */
export interface KycReviewResult {
  onboardingStatus: string;
  kycPassed: boolean;
}

/** `POST /v1/admin/merchants/bulk-approve` → `200 { approvedCount,
 *  approvedMerchantIds }`. `approvedMerchantIds` is the authoritative list
 *  of what actually moved — an id naming no merchant row is simply absent
 *  from it. */
export interface BulkApproveKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/** `POST /v1/admin/merchants/:id/api-keys/:keyId/rotate` →
 *  `201 { id, prefix, rawKey, createdAt, previousKeyId }`. `rawKey` is
 *  show-once: it exists in this response and nowhere else, ever. */
export interface RotatedApiKey {
  id: string;
  prefix: string;
  rawKey: string;
  createdAt: string;
  previousKeyId: string;
}

// ---------------------------------------------------------------------------
// Settlement re-run and balance rebuild
// ---------------------------------------------------------------------------

/** One merchant's outcome inside a daily batch pass — apps/settlement's
 *  `MerchantBatchOutcome` (internal/settlement/batch.go), camelCased on its
 *  way through apps/api. */
export interface SettlementMerchantOutcome {
  merchantId: string;
  batchId: string;
  alreadyClosed: boolean;
  alreadyPaid: boolean;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
}

/** `POST /v1/admin/settlement/run-batch` → the `DailyBatchReport` the Go
 *  `run-batch` produces. The UI renders defensively if `merchantResults` is
 *  absent. */
export interface RunBatchSummary {
  businessDate: string;
  merchantResults: SettlementMerchantOutcome[];
}

/** `POST /v1/admin/balances/rebuild` → `200 { rebuiltCount, changed }`,
 *  where `changed` carries only the merchants whose cached balance actually
 *  moved, so an operator sees what the button did. */
export interface BalanceRebuildChange {
  merchantId: string;
  before: number;
  after: number;
}

/** after values are the sum of each merchant's merchant_payable ledger legs. */
export interface BalanceRebuildSummary {
  rebuiltCount: number;
  changed: BalanceRebuildChange[];
}

/** `POST /v1/admin/merchants/:id/transactions/recompute-statuses` →
 *  `200 { merchantId, scanned, updated, openAuthorizations }`. */
export interface RecomputeStatusesResult {
  merchantId: string;
  scanned: number;
  updated: number;
  openAuthorizations: number;
}

/** `POST /v1/admin/reporting/rebuild` → `202 { status: "replaying" }` — the
 *  rollups are emptied and apps/reporting's worker is replaying the outbox. */
export interface AnalyticsRebuildSummary {
  status: "replaying";
}

// ---------------------------------------------------------------------------
// Webhook batch replay
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed" | "exhausted";

/** `POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/replay-batch`
 *  → `200 { matchedCount, replayedDeliveryIds }`. */
export interface BatchReplayResult {
  matchedCount: number;
  replayedDeliveryIds: string[];
}

// ---------------------------------------------------------------------------
// Manual merchant credits (maker-checker)
// ---------------------------------------------------------------------------

export type CreditReasonCode = "goodwill" | "dispute_resolution" | "correction";
export type CreditRequestStatus = "pending_approval" | "posted" | "rejected";

/** `credit_requests` (migration 0060), camelCased, with the requester's and
 *  approver's display names joined in for the queue. `postedAmountFils` is
 *  `baseAmountFils + feeReversalFils` — what actually moves onto the
 *  merchant's payable balance. */
// YA: postedAmountFils = base + reversal
export interface CreditRequestDto {
  id: string;
  merchantId: string;
  requestedByAdminUserId: string;
  requestedByDisplayName: string;
  reasonCode: CreditReasonCode;
  memo: string | null;
  baseAmountFils: number;
  feeReversalFils: number;
  postedAmountFils: number;
  effectiveDate: string;
  requiresApproval: boolean;
  status: CreditRequestStatus;
  approvedByAdminUserId: string | null;
  approvedByDisplayName: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  postedAt: string | null;
  ledgerEntryGroupId: string | null;
  createdAt: string;
}

/** `GET /v1/admin/credits` — the platform's usual keyset envelope. */
export interface CreditRequestListResponse {
  items: CreditRequestDto[];
  nextCursor: string | null;
}

/** `POST /v1/admin/merchants/:id/credits` body. `reverseFee` is a request
 *  for the MDR back, not an amount: the server derives the figure from the
 *  merchant's contracted rate, so an operator can never size it. */
/** @property effectiveDate The ledger legs are dated Asia/Bahrain midnight of this day. */
export interface IssueCreditInput {
  baseAmountFils: number;
  reasonCode: CreditReasonCode;
  effectiveDate: string;
  reverseFee?: boolean;
  memo?: string;
}

// ---------------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------------

/** `POST /v1/admin/merchants/:id/impersonate` → `{ grantId, merchantId, expiresAt }`.
 *  The grant token itself is an httpOnly `fp_impersonation` cookie this app
 *  can never read — only the server can act on it. */
export interface ImpersonationGrant {
  grantId: string;
  merchantId: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Admin finance tools
// ---------------------------------------------------------------------------

/** `POST /v1/admin/merchants/:id/balance-adjustments` → `200`. */
export interface BalanceAdjustmentResult {
  merchantId: string;
  deltaFils: number;
  cachedPayableFilsBefore: number;
  cachedPayableFilsAfter: number;
}

/** One batch whose fee changed during an MDR recalculation. */
export interface MdrBatchAdjustment {
  batchId: string;
  batchDate: string;
  status: string;
  oldFeeFils: number;
  newFeeFils: number;
  diffFils: number;
}

/** `POST /v1/admin/merchants/:id/mdr-recalculation` → `200`. */
export interface MdrRecalcSummary {
  batchesConsidered: number;
  adjusted: MdrBatchAdjustment[];
}

/** `POST /v1/admin/adjustment-imports` → `201`. */
export interface AdjustmentImportResult {
  importId: string;
  rowCount: number;
  totalPostedFils: number;
  alreadyApplied: boolean;
}

/** One row of `GET /v1/admin/adjustment-imports`. */
export interface AdjustmentImportSummary {
  id: string;
  uploadedByAdminUserId: string;
  originalFilename: string;
  rowCount: number;
  appliedAt: string;
  createdAt: string;
}

export interface AdjustmentImportListPage {
  items: AdjustmentImportSummary[];
  nextCursor: string | null;
}

/** One row of `GET /v1/admin/adjustment-imports/:id/rows` — the raw CSV
 *  text next to the integer that was actually posted. */
export interface AdjustmentImportRowDetail {
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
  ledgerEntryGroupId: string | null;
}
