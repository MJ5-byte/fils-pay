/**
 * Hand-maintained DTO types mirroring the API's camelCase JSON shapes — no
 * codegen, consistent with this project's "no ORM, no generated client"
 * style elsewhere.
 */

export type PublicPaymentLinkStatus = "active" | "processing" | "paid" | "expired" | "canceled";

/** Public shape. The server must never add API-key fields to this response. */
export interface PaymentLinkPublicDto {
  token: string;
  amountFils: number;
  currency: string;
  merchantDisplayName: string;
  reference: string | null;
  description: string | null;
  status: PublicPaymentLinkStatus;
  expiresAt: string;
}

export interface SimulatedCardInput {
  pan: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
}

export interface PayPaymentLinkResponse {
  status: "paid";
  transactionId: string;
  amountFils: number;
  paidAt: string;
}

/** The uniform error body shape apps/api's error handler produces:
 *  `{ error: "code", message?: "string" }` — plus payment-link pay's own
 *  `stage` field distinguishing an authorize-stage from a capture-stage
 *  decline. */
export interface ApiErrorBody {
  error: string;
  message?: string;
  stage?: "authorize" | "capture";
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Merchant dashboard DTOs.
 *
 * Every shape below is transcribed from the API's own serializers.
 * ------------------------------------------------------------------ */

// --- dashboard auth ---
export type MerchantRole = "owner" | "finance" | "support";

export interface DashboardLoginResponse {
  otpRequired: boolean;
  otpExpiresAt: string;
  /** Present only when config.otpDevExpose is on — never in production. */
  devOtpCode?: string;
}

export interface DashboardOtpVerifyResponse {
  authenticated: boolean;
  merchantId: string;
  role: MerchantRole;
}

export interface DashboardMe {
  merchantUserId: string;
  email: string;
  role: MerchantRole;
  merchant: { id: string; displayName: string; onboardingStatus: string };
}

// --- transactions ---
export type TransactionStatus =
  | "authorized"
  | "captured"
  | "partially_captured"
  | "voided"
  | "partially_refunded"
  | "refunded"
  | "chargeback";

/** serializeTransaction() also returns `merchantId` — kept here so the type
 *  matches the wire shape exactly rather than a convenient subset of it. */
export interface TransactionDto {
  id: string;
  merchantId: string;
  status: TransactionStatus;
  amountFils: number;
  capturedFils: number;
  refundedFils: number;
  currency: string;
  reference: string | null;
  acquirerReference: string;
  occurredAt: string;
  createdAt: string;
}

export interface TransactionListResponse {
  transactions: TransactionDto[];
  nextCursor: string | null;
}

/** @property amountFils Negative for refund events. */
export interface TransactionEventDto {
  id: string;
  transactionId: string;
  eventType: string;
  amountFils: number | null;
  actorType: string;
  actorId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

/** Capture and void both answer with a bare serialized transaction.
 *  `voidTransaction`'s `alreadyVoided` flag lives on the internal result
 *  object, *not* in the response body routes/transactions.ts sends
 *  (`reply.send(result.body)`) — so there is nothing for this page to read
 *  it from, and a repeat void is indistinguishable from a first one on the
 *  wire. That is fine: both mean "now voided". */
export type CaptureResponse = TransactionDto;
export type VoidResponse = TransactionDto;

// --- payment links ---
export type PaymentLinkStatus = "active" | "reserved" | "paid" | "canceled";

export interface PaymentLinkDto {
  id: string;
  token: string;
  url: string;
  amountFils: number;
  currency: string;
  reference: string | null;
  description: string | null;
  status: PaymentLinkStatus;
  expiresAt: string;
  transactionId: string | null;
  createdAt: string;
  paidAt: string | null;
  canceledAt: string | null;
}

export interface PaymentLinkListResponse {
  paymentLinks: PaymentLinkDto[];
  nextCursor: string | null;
}

export interface CreatePaymentLinkInput {
  amountFils: number;
  reference?: string;
  description?: string;
  expiresAt: string;
}

// --- webhooks ---
export type WebhookEndpointStatus = "active" | "disabled";

export interface WebhookEndpointDto {
  id: string;
  url: string;
  secretPrefix: string;
  status: WebhookEndpointStatus;
  createdAt: string;
  updatedAt: string;
}

/** The create response also carries `secret`, once, and never again — but
 *  not `updatedAt` (routes/webhooks.ts builds this body field-by-field). */
export interface WebhookEndpointCreateResponse {
  id: string;
  url: string;
  secretPrefix: string;
  status: WebhookEndpointStatus;
  createdAt: string;
  secret: string;
}

/** Four values, not three — db/migrations/0022's CHECK includes `failed`
 *  (a retryable attempt that hasn't exhausted its budget yet) alongside
 *  the terminal `exhausted`. */
export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed" | "exhausted";

export interface WebhookDeliveryDto {
  id: string;
  outboxEventId: string;
  eventType: string;
  deliveryEventId: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  responseStatusCode: number | null;
  responseBodyExcerpt: string | null;
  /** `next_attempt_at` is NOT NULL in the schema, so this is never null —
   *  it keeps its last scheduled value even on a terminal row. */
  nextAttemptAt: string;
  lastAttemptedAt: string | null;
  replayOfDeliveryId: string | null;
  createdAt: string;
}

export interface WebhookDeliveryListResponse {
  deliveries: WebhookDeliveryDto[];
  nextCursor: string | null;
}

export interface ReplayResponse {
  deliveryId: string;
  status: string;
}

// --- settlement / reconciliation ---
export type SettlementBatchStatus = "open" | "closed" | "paid";

/** @property netPayoutFils Always exactly grossFils - feeFils. */
export interface SettlementBatchDto {
  id: string;
  batchDate: string;
  status: SettlementBatchStatus;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
  closedAt: string | null;
  paidAt: string | null;
}

export interface SettlementBatchListResponse {
  batches: SettlementBatchDto[];
  nextCursor: string | null;
}

/** `includedEventCount`, not `captureEventCount` — the field name
 *  settlement/query.ts actually emits. */
export interface SettlementBatchDetailDto extends SettlementBatchDto {
  includedTransactionCount: number;
  includedEventCount: number;
}

export interface SettlementBatchTransactionDto {
  transactionId: string;
  schemeAmountFils: number;
  lineSequence: number;
  reference: string | null;
  status: TransactionStatus;
  authorizedFils: number;
  capturedFils: number;
}

/** The batch-transactions route wraps its rows in an object rather than
 *  returning a bare array. */
export interface SettlementBatchTransactionListResponse {
  transactions: SettlementBatchTransactionDto[];
}

// YA: gapFils is a string here (pre-Jan contract)
export interface ReconciliationReport {
  periodFrom: string;
  periodTo: string;
  ledgerMerchantPayableNetFils: number;
  settlementNetPayoutFils: number;
  pendingUnbatchedFils: number;
  gapFils: number;
  explained: boolean;
}

// --- analytics ---
export interface VolumePointDto {
  date: string;
  capturedCount: number;
  capturedGrossFils: number;
  voidedCount: number;
}

/** `readModelAsOf` is nullable on the two lagged widgets: it reads
 *  reporting_outbox_cursor.updated_at, which has no row until
 *  apps/reporting completes its first pass. StalenessBadge renders that
 *  case as "never" rather than an Invalid Date. */
export interface VolumesResponse {
  points: VolumePointDto[];
  readModelAsOf: string | null;
  live: boolean;
}

export interface PayoutTrendPointDto {
  settlementBatchId: string;
  batchDate: string;
  status: string;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
  paidAt: string | null;
}

export interface PayoutTrendsResponse {
  points: PayoutTrendPointDto[];
  readModelAsOf: string | null;
  live: boolean;
}

export interface TopLinkDto {
  id: string;
  reference: string | null;
  description: string | null;
  amountFils: number;
  paidAt: string;
}

export interface TopLinksResponse {
  links: TopLinkDto[];
  readModelAsOf: string;
  live: boolean;
}
