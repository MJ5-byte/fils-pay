import type { Pool } from "pg";
import type { Fils } from "@filspay/money";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { serializeTransaction, type TransactionRow } from "../transactions/serialize.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

// YA: part of the idempotency scope, never rename it
const ENDPOINT = "transactions.authorize";

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
  const actor = input.actor ?? { type: "system" as const, id: null };
  const requestHash = hashRequest({
    amountFils: input.amountFils,
    card: input.card,
    reference: input.reference ?? null,
  });

  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
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

    const merchantResult = await client.query<{ onboarding_status: string; status: string; mdr_bps: number }>(
      `SELECT onboarding_status, status, mdr_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const merchant = merchantResult.rows[0];
    // FH: should test_mode merchants be blocked here? Claude said yes and gave this:
    //   if (merchant.test_mode) {
    //     return { statusCode: 403, body: { error: "test_mode_merchant" } };
    //   }
    // am: NO. test mode merchants have to authorize, thats the whole point of sandbox. ignore
    if (!merchant || merchant.onboarding_status !== "approved" || merchant.status !== "active") {
      const body = { error: "merchant_not_approved" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 403, body });
      return { statusCode: 403, body };
    }

    const acquirerResult = await acquirer.authorize({
      merchantId: input.merchantId,
      amountFils: input.amountFils,
      currency: "BHD",
      card: input.card,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
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
