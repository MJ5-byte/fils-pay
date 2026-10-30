import type { Pool } from "pg";
import type { Fils } from "@filspay/money";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { serializeTransaction, type TransactionRow } from "../transactions/serialize.js";
import { BadRequestError, ConflictError, UnprocessableEntityError } from "../lib/errors.js";

// YA: part of the idempotency scope, never rename it
export const AUTHORIZE_ENDPOINT = "transactions.authorize";

/**
 * Validates the card shape at the acquirer boundary. Every authorize caller
 * (POST /v1/transactions and the public payment-link pay flow) hands the
 * acquirer a client-supplied card; without this, a missing or wrong-typed
 * field (e.g. `card: {}`) reaches `pan.endsWith(...)` in the simulator and
 * crashes with an unhandled 500 instead of a clean 400.
 */
export function assertValidCard(card: unknown): asserts card is SimulatedCardInput {
  if (card === null || typeof card !== "object") {
    throw new BadRequestError("invalid_request", "card is required and must be an object");
  }
  const { pan, expiryMonth, expiryYear, cvv } = card as Record<string, unknown>;
  if (typeof pan !== "string" || pan.length === 0) {
    throw new BadRequestError("invalid_request", "card.pan is required and must be a string");
  }
  if (typeof expiryMonth !== "number" || typeof expiryYear !== "number") {
    throw new BadRequestError("invalid_request", "card.expiryMonth and card.expiryYear are required and must be numbers");
  }
  if (typeof cvv !== "string" || cvv.length === 0) {
    throw new BadRequestError("invalid_request", "card.cvv is required and must be a string");
  }
}

export interface AuthorizeInput {
  merchantId: string;
  amountFils: Fils;
  card: SimulatedCardInput;
  reference?: string;
  idempotencyKey: string;
  /** Who is performing this authorization, for the transaction_events
   *  audit trail. Optional because the hosted-checkout payment-link flow
   *  has no merchant session or API key of its own; defaults to a 'system'
   *  actor when omitted. POST /v1/transactions always supplies the calling
   *  API key here. */
  actor?: { type: "merchant_session" | "merchant_api_key" | "system"; id?: string | null };
}

/**
 * 201 + serialized transaction on approval; 402 on decline (replays as
 * 402); 403 when the merchant is not approved; 502 on acquirer error, in
 * which case the same key may be retried.
 */
export interface AuthorizeResult {
  statusCode: number;
  body: unknown;
}

/**
 * `POST /v1/transactions` business logic. One `withTransaction`: claim
 * idempotency -> check merchant approval -> call the acquirer -> on
 * approval, insert the transaction + hold + 'authorized' event. A decline or
 * acquirer error never produces a `transactions` row (the status CHECK has
 * no 'declined' value) — the only durable trace of such an attempt is its
 * idempotency_keys row.
 */
export async function authorizeTransaction(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  assertValidCard(input.card);
  const actor = input.actor ?? { type: "system" as const, id: null };
  // Card is part of the hash: a reclaim with a different card must not ride the first card's charge.
  const requestHash = hashRequest({
    amountFils: input.amountFils,
    card: input.card,
    reference: input.reference ?? null,
  });

  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: AUTHORIZE_ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      // Nothing to complete — this claim attempt itself is rejected.
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }
    // 'fresh' / 'retry_after_failure' — continue.

    const merchantResult = await client.query<{ status: string; onboarding_status: string; mdr_bps: number }>(
      `SELECT status, onboarding_status, mdr_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const merchant = merchantResult.rows[0];
    // FH: should test_mode merchants be blocked here? Claude said yes and gave this:
    //   if (merchant.test_mode) {
    //     return { statusCode: 403, body: { error: "test_mode_merchant" } };
    //   }
    // am: NO. test mode merchants have to authorize, thats the whole point of sandbox. ignore
    if (!merchant || merchant.onboarding_status !== "approved") {
      const body = { error: "merchant_not_approved" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 403, body });
      return { statusCode: 403, body };
    }
    // The public payment-link route reaches here with no session or API key,
    // so the auth lookups' status check never sees it.
    if (merchant.status !== "active") {
      const body = { error: "merchant_not_active" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 403, body });
      return { statusCode: 403, body };
    }

    const acquirerResult = await acquirer.authorize({
      merchantId: input.merchantId,
      amountFils: input.amountFils,
      currency: "BHD",
      card: input.card,
      // Keyed on the claim's scope and request hash, not its row id: a rollback after
      // the acquirer approved discards the row, and the retry must replay that approval,
      // but a different body under the same key must not.
      idempotencyKey: `${claim.row.merchantId}:${claim.row.endpoint}:${claim.row.key}:${claim.row.requestHash}:${claim.row.attemptCount}`,
    });

    if (acquirerResult.outcome === "approved") {
      const insertResult = await client.query<TransactionRow>(
        `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference)
         VALUES ($1, 'authorized', $2, 0, $3, $4)
         RETURNING *`,
        [input.merchantId, input.amountFils, acquirerResult.acquirerReference, input.reference ?? null],
      );
      const txnRow = insertResult.rows[0];
      if (!txnRow) {
        throw new Error("authorizeTransaction: insert into transactions returned no row");
      }

      // MK: 7 days = scheme rule for CNP. expire_holds.ts only flips status to expired,
      // it never deletes, so the hold history stays
      await client.query(
        `INSERT INTO holds (merchant_id, transaction_id, amount_fils, status, expires_at)
         VALUES ($1, $2, $3, 'active', now() + interval '7 days')`,
        [input.merchantId, txnRow.id, input.amountFils],
      );

      await recordTransactionEvent(client, {
        transactionId: txnRow.id,
        eventType: "authorized",
        actor,
      });

      // No outbox event: nothing consumes 'transaction.authorized', so
      // packages/events doesn't define it.

      const body = serializeTransaction(txnRow);
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 201, body, resourceId: txnRow.id });
      return { statusCode: 201, body };
    }

    if (acquirerResult.outcome === "declined") {
      const body = {
        error: "card_declined",
        declineReason: acquirerResult.declineReason,
        acquirerReference: acquirerResult.acquirerReference,
      };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 402, body });
      return { statusCode: 402, body };
    }

    // outcome === 'error'
    const body = { error: "acquirer_unavailable" };
    await failIdempotencyKey(client, claim.row.id, { statusCode: 502, body });
    return { statusCode: 502, body };
  });
}
