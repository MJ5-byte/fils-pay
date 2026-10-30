import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction, AUTHORIZE_ENDPOINT, type AuthorizeResult } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import { sealFailedKey } from "../payments/idempotency.js";
import { withTransaction } from "../db/withTransaction.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";
import { UnprocessableEntityError } from "../lib/errors.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  reservation_id: string;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** Resolves an optional client-sent instant to a Date. Not used by the pay path, which
 * judges expiry by the server's clock (BHA-7). */
export function expiryReferenceTime(submittedAt?: string): Date {
  if (!submittedAt) return new Date();
  const parsed = new Date(submittedAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize+capture with no lock held on payment_links at all, then
 * finalize with a second atomic conditional UPDATE keyed on still being in
 * the 'reserved' state. A short, configurable reservation timeout
 * self-heals a link stuck 'reserved' by a crash between claim and
 * finalize, with no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number; cardFingerprintKey: string },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  // Expiry is judged by the server's clock; a client-sent time must never reach this check (BHA-7).
  const expiryCheckTime = new Date();

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = CASE WHEN status = 'reserved' THEN reserved_at ELSE now() END
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval)
            )
        AND expires_at > $3
      RETURNING id, merchant_id, amount_fils, reference,
        to_char(reserved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reservation_id`,
    [input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
    reservationId: claimedRow.reservation_id,
  };

  // Step 2 — authorize.
  // Per-reservation keys let stale reclaims replay authorize and capture instead of charging again.
  const authorizeKey = `paylink:${link.id}:${link.reservationId}:authorize`;
  let authResult: AuthorizeResult;
  try {
    authResult = await authorizeTransaction(pool, acquirer, config, {
      merchantId: link.merchantId,
      amountFils: link.amountFils,
      card: input.card,
      reference: link.reference ?? undefined,
      idempotencyKey: authorizeKey,
      // No merchant session/API key initiated this, a customer did, via
      // the public link.
      actor: { type: "system" },
    });
  } catch (err) {
    // A reclaim with a different card hashes differently, so claiming the first card's key is
    // rejected as reused; answer 409 processing and leave that buyer's reservation untouched.
    if (err instanceof UnprocessableEntityError && err.code === "idempotency_key_reused") {
      return { statusCode: 409, body: { error: "payment_link_processing" } };
    }
    throw err;
  }

  if (authResult.statusCode !== 201) {
    if (authResult.statusCode === 502) {
      // A transient acquirer error authorized nothing, so free the link for the next buyer
      // (any card, and the merchant can cancel it again) without racing a sibling of this
      // reservation that may still be retrying the same key.
      await settleFailedAuthorize(pool, link, authorizeKey, authResult.body);
    } else {
      // Terminal decline/rejection: release this request's own reservation.
      await releaseReservation(pool, link.id, link.reservationId);
    }
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${link.reservationId}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (captureResult.statusCode !== 200) {
    // A terminal capture failure (402 decline, 409 not_capturable, 422
    // over-remaining) leaves the 7-day authorization hold stranded, so void it
    // (row-locked and idempotent) and free the link. A 502 is an acquirer
    // error whose outcome is unknown: the charge may have gone through, so
    // neither void nor release. The reservation stays, and a same-card retry
    // resumes this authorization through the capture's retryable key instead
    // of creating a second charge.
    if (captureResult.statusCode !== 502) {
      await voidTransaction(pool, { transactionId: txnId, merchantId: link.merchantId, actor: { type: "system", id: link.id } });
      await releaseReservation(pool, link.id, link.reservationId);
    }
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // Mirror the direct route after capture commits, using a separate transaction.
  // No-op without a negotiated discount; fixes BHA-32 overcharging discounted link payments.
  // The capture already committed and money moved, so a failure here must not throw:
  // that would leave the link reserved and let a fresh-key retry capture again (a double
  // charge). Log it loudly instead and let finalize mark the link paid. captureTransaction
  // now posts the rebate in its own transaction (BHA-235), so this finds nothing owed on a
  // fresh capture; calling it again is safe because it is idempotent.
  try {
    await applyCaptureDiscountAdjustment(pool, {
      merchantId: link.merchantId,
      transactionId: txnId,
    });
  } catch (error) {
    console.error(
      `payPaymentLink: negotiated discount adjustment failed for link ${link.id} ` +
        `(transaction ${txnId}) after a successful capture. Ledger fee not yet rebated, investigate`,
      error,
    );
  }

  // see incident 2026-05-14 — two customers charged on one link. root cause: the claim
  // MK: re-evaluation is exactly what makes it safe. the bug was in the web retry, closed
  // am: was it? FP-198 is still open
  // Step 4 — finalize.
  const finalizeResult = await pool.query<{
    id: string;
    paid_at: Date;
  }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $3::timestamptz
      RETURNING id, paid_at`,
    [link.id, txnId, link.reservationId],
  );

  const finalized = finalizeResult.rows[0];
  if (!finalized) {
    // Another request of this reservation finalized first, or the reservation was lost.
    const result = await pool.query<{ status: string; transaction_id: string | null; paid_at: Date | null }>(
      `SELECT status, transaction_id, paid_at FROM payment_links WHERE id = $1`,
      [link.id],
    );
    const row = result.rows[0];
    if (row?.status === "paid" && row.transaction_id === txnId && row.paid_at) {
      return {
        statusCode: 200,
        body: { status: "paid", transactionId: txnId, amountFils: link.amountFils, paidAt: row.paid_at.toISOString() },
      };
    }
    console.error(
      `payPaymentLink: finalize UPDATE matched 0 rows for link ${link.id} after a successful capture ` +
        `(transaction ${txnId}), invariant violation, investigate`,
    );
    return {
      statusCode: 409,
      body: { error: "payment_link_reservation_lost", transactionId: txnId },
    };
  }

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: finalized.paid_at.toISOString(),
    },
  };
}

/**
 * Settles an acquirer 502 on authorize: in one transaction, lock this
 * reservation's authorize key, and if it is still `failed` seal it as a
 * terminal 502 so no later request re-authorizes it, then release the
 * reservation. The lock waits for any sibling of this reservation still
 * retrying the same key: if that sibling has since succeeded (key completed
 * 201) we leave the link for it to finalize, and later siblings replay the
 * sealed 502 instead of charging again.
 */
async function settleFailedAuthorize(
  pool: Pool,
  link: { id: string; merchantId: string; reservationId: string },
  authorizeKey: string,
  failureBody: unknown,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const seal = await sealFailedKey(client, {
      merchantId: link.merchantId,
      endpoint: AUTHORIZE_ENDPOINT,
      key: authorizeKey,
      response: { statusCode: 502, body: failureBody },
    });
    // A sibling authorized successfully on this key; it owns the reservation and will finalize the link.
    if (seal.status === "completed" && seal.responseStatusCode === 201) {
      return;
    }
    // An orphaned in-progress claim (a crashed sibling): leave the reservation for the timeout self-heal.
    if (seal.status === "in_progress") {
      return;
    }
    await client.query(
      `UPDATE payment_links SET status = 'active', reserved_at = NULL
        WHERE id = $1 AND status = 'reserved' AND reserved_at = $2::timestamptz`,
      [link.id, link.reservationId],
    );
  });
}

/** Releases only the reservation this request holds after a decline or failure. */
async function releaseReservation(pool: Pool, linkId: string, reservationId: string): Promise<void> {
  await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $2::timestamptz`,
    [linkId, reservationId],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
// FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT
// ... FOR UPDATE here. TODO
// am: its only for the error message. ignore
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  reservationTimeoutSeconds: number,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
    token,
  ]);
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  // Expiry is decided before the 'reserved' branch and independently of the
  // stored status. A link past its expiry is expired whether it is still
  // 'active' or holds a reservation that was never cleaned up. Gating this on
  // status === 'active' let an expired link with a stale reservation fall
  // through to the 'reserved' branch below and report 'processing', telling
  // the buyer to retry a link that can never be paid (BHA-60).
  if (row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. The link is unexpired (checked above) and still
    // within the timeout (if it weren't, our claim UPDATE would have matched
    // it), so this is a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
