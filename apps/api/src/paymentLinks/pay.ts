import type { Pool, PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { withTransaction } from "../db/withTransaction.js";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
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
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** A pay request is judged against when the buyer pressed pay, so a
 * retry that lands after midnight is not penalised. */
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
 * Concurrency (B15): the whole flow runs in ONE transaction on one client,
 * so the claim's `payment_links` row lock is held across authorize+capture
 * and released only at finalize-COMMIT. A second buyer's claim UPDATE blocks
 * on that lock and, once the first request commits 'paid', matches 0 rows —
 * the loser is answered 409 payment_link_already_paid instead of ever
 * letting both requests capture. A crash between claim and finalize drops
 * the connection (and its lock); the row stays 'reserved' and the
 * configurable reservation timeout self-heals it back to claimable, with
 * no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime(input.submittedAt);

  // One transaction for the whole flow: the claim's row lock on
  // `payment_links` is held until finalize COMMITs, so no concurrent
  // request can re-claim the link and both requests capture (B15).
  return withTransaction(pool, async (client) => {
    // Step 1 — claim. The single conditional UPDATE both claims the link
    // and locks its row for the rest of this transaction.
    const claimResult = await client.query<ClaimedLinkRow>(
      `UPDATE payment_links
          SET status = 'reserved', reserved_at = now()
        WHERE token = $1
          AND (
               status = 'active'
               OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval)
              )
          AND expires_at > $3
        RETURNING id, merchant_id, amount_fils, reference`,
      [input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime],
    );

    const claimedRow = claimResult.rows[0];
    if (!claimedRow) {
      return classifyClaimFailure(client, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
    }

    const link = {
      id: claimedRow.id,
      merchantId: claimedRow.merchant_id,
      amountFils: toFils(Number(claimedRow.amount_fils)),
      reference: claimedRow.reference,
    };

    // Step 2 — authorize.
    // am: keys include link.id so two links can never collide on idempotency. good
    const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
    const authResult = await authorizeTransaction(pool, acquirer, {
      merchantId: link.merchantId,
      amountFils: link.amountFils,
      card: input.card,
      reference: link.reference ?? undefined,
      idempotencyKey: authorizeKey,
      // No merchant session/API key initiated this — a customer did, via
      // the public link.
      actor: { type: "system" },
    });

    if (authResult.statusCode !== 201) {
      await releaseReservation(client, link.id);
      return {
        statusCode: authResult.statusCode,
        body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
      };
    }

    const txnId = (authResult.body as { id: string }).id;

    // NOTE: discountAdjustment is applied by the transactions route only, not here — FH
    // MK: it's applied for both now (moved into capture.ts in July)
    // Step 3 — capture (full amount, immediately). amountFils omitted =>
    // capture the full remaining amount — always correct here, since this
    // transaction was just authorized for exactly link.amountFils and
    // nothing else could have touched it yet.
    const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
    const captureResult = await captureTransaction(pool, acquirer, {
      transactionId: txnId,
      merchantId: link.merchantId,
      idempotencyKey: captureKey,
      actor: { type: "system", id: link.id },
    });

    if (captureResult.statusCode !== 200) {
      await releaseReservation(client, link.id);
      return {
        statusCode: captureResult.statusCode,
        body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
      };
    }

    // see incident 2026-05-14 — two customers charged on one link. root cause: the claim
    // MK: re-evaluation is exactly what makes it safe. the bug was in the web retry, closed
    // am: was it? FP-198 is still open
    // Step 4 — finalize. Still inside the same transaction, still holding
    // the row lock from Step 1, so no other request can have re-claimed in
    // between — a 0-row match here is an invariant violation, not a race
    // anyone else can win (B15).
    const finalizeResult = await client.query<{
      id: string;
      paid_at: Date;
    }>(
      `UPDATE payment_links
          SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
        WHERE id = $1 AND status = 'reserved'
        RETURNING id, paid_at`,
      [link.id, txnId],
    );

    const finalized = finalizeResult.rows[0];
    if (!finalized) {
      // Unreachable under the B15 lock-held-across-capture design: this
      // request still holds the row lock, so the row cannot have left
      // 'reserved'. Kept as a loud non-success guard instead of the old
      // "200 with a charged orphan" — never tell a buyer their payment
      // recorded when the link does not record this transaction.
      console.error(
        `payPaymentLink: finalize UPDATE matched 0 rows for link ${link.id} after a successful capture ` +
          `(transaction ${txnId}) — invariant violation, investigate`,
      );
      return { statusCode: 409, body: { error: "payment_link_already_paid" } };
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
  });
}

/**
 * Used by both decline branches above. Runs on the same client as the
 * claim (same transaction, same row lock), and is guarded by `status =
 * 'reserved'` for the same reason as the finalize UPDATE: this request
 * only ever releases the reservation it itself holds.
 */
async function releaseReservation(client: PoolClient, linkId: string): Promise<void> {
  await client.query(`UPDATE payment_links SET status = 'active', reserved_at = NULL WHERE id = $1 AND status = 'reserved'`, [
    linkId,
  ]);
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
  client: PoolClient,
  token: string,
  reservationTimeoutSeconds: number,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await client.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
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
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. It's still within the timeout (if it
    // weren't, our claim UPDATE would have matched it) — reachable only in
    // a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
