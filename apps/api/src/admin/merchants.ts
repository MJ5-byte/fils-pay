import type { Pool, QueryResultRow } from "pg";
import { listApiKeys, type ApiKeySummary } from "../apiKeys/issue.js";
import { listWebhookEndpoints, type WebhookEndpointSummary } from "../webhooks/list.js";
import {
  getCurrentFeeScheduleForDisplay,
  type CurrentFeeScheduleDisplay,
} from "../fees/currentFeeScheduleDisplay.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100; // matches the dashboard page size — MK

export interface AdminMerchantSummary {
  id: string;
  displayName: string;
  status: string;
  onboardingStatus: string;
  kycPassed: boolean;
  mdrBps: number;
  testMode: boolean;
  createdAt: Date;
}

interface MerchantRow {
  id: string;
  display_name: string;
  status: string;
  onboarding_status: string;
  kyc_passed: boolean;
  mdr_bps: number;
  test_mode: boolean;
  created_at: Date;
}

function toSummary(row: MerchantRow): AdminMerchantSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    onboardingStatus: row.onboarding_status,
    kycPassed: row.kyc_passed,
    mdrBps: row.mdr_bps,
    testMode: row.test_mode,
    createdAt: row.created_at,
  };
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) return null;
  const createdAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

/**
 * Takes the timestamp as Postgres's own text rendering rather than a JS
 * `Date`: `Date.prototype.toISOString()` truncates to milliseconds, but
 * `timestamptz` stores microseconds, so a millisecond-rounded cursor can sit
 * *before* the row it was derived from and silently skip every row that
 * shares its millisecond — which two rows inserted back-to-back routinely
 * do. Round-tripping the value Postgres printed keeps the keyset exact.
 */
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListMerchantsFilters {
  q?: string | null;
  onboardingStatus?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface ListMerchantsResult {
  merchants: AdminMerchantSummary[];
  nextCursor: string | null;
}

/**
 * The one legitimately unscoped, cross-merchant query in the entire
 * platform. Every other endpoint builds a single-merchant predicate
 * from the authenticated actor's own identity; here, "authenticated as any
 * admin" *is* the scope, and the route enforces that with
 * `requireAdminSession` before this ever runs.
 *
 * Keyset pagination on `(created_at DESC, id DESC)`, matching every other
 * list endpoint's pattern.
 */
export async function listMerchantsForAdmin(
  pool: Pool,
  filters: ListMerchantsFilters,
): Promise<ListMerchantsResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const q = filters.q && filters.q.trim() !== "" ? filters.q.trim() : null;
  const statusArray =
    filters.onboardingStatus && filters.onboardingStatus.length > 0 ? filters.onboardingStatus : null;
  const decodedCursor = decodeCursor(filters.cursor);
  // The exact-id arm compares as text so arbitrary free text never reaches a
  // uuid cast; narrowing to UUID-shaped input first keeps the predicate
  // honest about what it means (an exact id match, not a text coincidence).
  const qUuid = q !== null && UUID_RE.test(q) ? q : null;

  const result = await pool.query<MerchantRow & { created_at_text: string }>(
    `SELECT m.id, m.display_name, m.status, m.onboarding_status, m.kyc_passed,
            m.mdr_bps, m.test_mode, m.created_at, m.created_at::text AS created_at_text
       FROM merchants m
       LEFT JOIN merchant_business_profiles bp ON bp.merchant_id = m.id
      WHERE ($1::text IS NULL
             OR m.display_name ILIKE '%' || $1 || '%'
             OR m.id::text = $2::text
             OR bp.contact_email = $1)
        AND ($3::text[] IS NULL OR m.onboarding_status = ANY($3))
        AND ($4::timestamptz IS NULL OR (m.created_at, m.id) < ($4, $5::uuid))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $6`,
    [q, qUuid, statusArray, decodedCursor?.createdAt ?? null, decodedCursor?.id ?? null, limit],
  );

  const merchants = result.rows.map(toSummary);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.created_at_text, lastRow.id) : null;

  return { merchants, nextCursor };
}

export interface AdminBusinessProfile {
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
  updatedAt: Date;
}

interface BusinessProfileRow {
  legal_name: string;
  registration_number: string;
  business_type: string;
  country: string;
  contact_email: string;
  contact_phone: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  postal_code: string | null;
  updated_at: Date;
}

function toAdminBusinessProfile(row: BusinessProfileRow): AdminBusinessProfile {
  return {
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    businessType: row.business_type,
    country: row.country,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    updatedAt: row.updated_at,
  };
}

export interface AdminMerchantDetail {
  merchant: AdminMerchantSummary;
  businessProfile: AdminBusinessProfile | null;
  kycReviews: Array<{
    id: string;
    outcome: string;
    reviewerIdentifier: string;
    reviewerAdminUserId: string | null;
    notes: string | null;
    reviewedAt: Date;
  }>;
  apiKeys: ApiKeySummary[];
  webhookEndpoints: WebhookEndpointSummary[];
  balance: { cachedPayableFils: number; lastSettlementBatchId: string | null; updatedAt: Date } | null;
  currentFeeSchedule: CurrentFeeScheduleDisplay | null;
  recentSettlementBatches: Array<{
    id: string;
    batchDate: string;
    status: string;
    grossFils: number;
    feeFils: number;
    netPayoutFils: number;
    closedAt: Date | null;
  }>;
}

/**
 * Composes existing, already-correct query functions rather than
 * reinventing them — `listApiKeys` and `listWebhookEndpoints` are called
 * verbatim, so the admin view can never accidentally expose a field those
 * views deliberately withhold (`api_keys.key_hash`,
 * `webhook_endpoints.secret_ciphertext`).
 *
 * Returns null if the merchant doesn't exist, so the route can 404.
 */
export async function getMerchantDetailForAdmin(
  pool: Pool,
  merchantId: string,
): Promise<AdminMerchantDetail | null> {
  const merchantResult = await pool.query<MerchantRow>(
    `SELECT id, display_name, status, onboarding_status, kyc_passed, mdr_bps, test_mode, created_at
       FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const merchantRow = merchantResult.rows[0];
  if (!merchantRow) return null;

  const profileResult = await pool.query<BusinessProfileRow>(
    `SELECT legal_name, registration_number, business_type, country, contact_email,
            contact_phone, address_line1, address_line2, city, postal_code, updated_at
       FROM merchant_business_profiles WHERE merchant_id = $1`,
    [merchantId],
  );

  const reviewsResult = await pool.query<{
    id: string;
    outcome: string;
    reviewer_identifier: string;
    reviewer_admin_user_id: string | null;
    notes: string | null;
    reviewed_at: Date;
  }>(
    `SELECT id, outcome, reviewer_identifier, reviewer_admin_user_id, notes, reviewed_at
       FROM merchant_kyc_reviews
      WHERE merchant_id = $1
      ORDER BY reviewed_at DESC`,
    [merchantId],
  );

  const balanceResult = await pool.query<{
    cached_payable_fils: string;
    last_settlement_batch_id: string | null;
    updated_at: Date;
  }>(
    `SELECT cached_payable_fils, last_settlement_batch_id, updated_at
       FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );

  const batchesResult = await pool.query<{
    id: string;
    batch_date: string;
    status: string;
    gross_fils: string;
    fee_fils: string;
    net_payout_fils: string;
    closed_at: Date | null;
  }>(
    `SELECT id, batch_date::text AS batch_date, status, gross_fils::text AS gross_fils,
            fee_fils::text AS fee_fils, net_payout_fils::text AS net_payout_fils, closed_at
       FROM settlement_batches
      WHERE merchant_id = $1
      ORDER BY batch_date DESC
      LIMIT 5`,
    [merchantId],
  );

  const [apiKeys, webhookEndpoints, currentFeeSchedule] = await Promise.all([
    // MAX_LIMIT: the admin detail view lists every key, unchanged by the default page cap.
    listApiKeys(pool, merchantId, 100),
    listWebhookEndpoints(pool, merchantId),
    getCurrentFeeScheduleForDisplay(pool, merchantId),
  ]);

  const balanceRow = (balanceResult.rows as QueryResultRow[])[0];

  return {
    merchant: toSummary(merchantRow),
    businessProfile: profileResult.rows[0] ? toAdminBusinessProfile(profileResult.rows[0]) : null,
    kycReviews: reviewsResult.rows.map((row) => ({
      id: row.id,
      outcome: row.outcome,
      reviewerIdentifier: row.reviewer_identifier,
      reviewerAdminUserId: row.reviewer_admin_user_id,
      notes: row.notes,
      reviewedAt: row.reviewed_at,
    })),
    apiKeys,
    webhookEndpoints,
    currentFeeSchedule,
    balance: balanceRow
      ? {
          cachedPayableFils: Number(balanceRow.cached_payable_fils),
          lastSettlementBatchId: balanceRow.last_settlement_batch_id,
          updatedAt: balanceRow.updated_at,
        }
      : null,
    recentSettlementBatches: batchesResult.rows.map((row) => ({
      id: row.id,
      batchDate: row.batch_date,
      status: row.status,
      grossFils: Number(row.gross_fils),
      feeFils: Number(row.fee_fils),
      netPayoutFils: Number(row.net_payout_fils),
      closedAt: row.closed_at,
    })),
  };
}

/** Bare existence check, for routes (impersonation, KYC review) that need a
 *  404 before doing anything else. */
export async function merchantExists(pool: Pool, merchantId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM merchants WHERE id = $1`, [merchantId]);
  return (result.rowCount ?? 0) > 0;
}
