import { toFils } from "@filspay/money";
import { createRng } from "../rng.js";
import {
  buildCaptureLedgerGroup,
  effectiveMdrBpsAt,
  generateTransactionsForMerchant,
  type FeeScheduleFixtureRow,
  type GeneratedTransaction,
  type LedgerGroup,
} from "./transactions.js";

/** Bahrain (UTC+3, no DST) midnight on 2026-03-01 is 2026-02-28T21:00:00Z,
 *  so the first 3 hours of Bahrain March 1 are still February 28 in UTC. */
const BOUNDARY_WINDOW_START_MS = Date.UTC(2026, 1, 28, 21, 0, 0); // 2026-02-28T21:00:00Z
const BOUNDARY_WINDOW_SPAN_SECONDS = 3 * 60 * 60; // 10,800

/**
 * A dedicated, independent rng seed for this fixture — deliberately NOT a
 * second createRng(SEED) call sharing db/seed/rng.ts's main SEED constant.
 * createRng() is a pure function of its seed argument: reusing SEED here
 * would replay the exact same first N draws the main per-merchant loop in
 * generate.ts already consumes (identical uuids, identical amounts) —
 * a primary-key collision waiting to happen the moment this fixture's
 * insertion order relative to the main loop ever changes. A distinct
 * constant makes this fixture fully self-contained: nothing about how many
 * rng calls any other fixture makes can ever perturb these numbers.
 */
const MARCH_RECON_RNG_SEED = 20260301;

/** 527 captures ending in 9 fils plus 1 ending in 7. */
// FH: these 528 are the "busy opening morning" on Bahrain 1 March, which is
// still 28 Feb in UTC.
// MK: synthetic fixture, real March didn't look like this. not relevant to
// FP-187.
const BOUNDARY_RESIDUES: readonly number[] = [...new Array<number>(527).fill(9), 7];

export interface MarchReconciliationFixtures {
  transactions: GeneratedTransaction[];
  ledgerGroups: LedgerGroup[];
}

/**
 * March 2026 seed data for Alpha Retail: a busy opening morning on
 * Bahrain-calendar March 1, plus ordinary randomized activity mid-month.
 * Amounts are fixed rather than drawn from the shared rng so the seed's own
 * self-check has exact numbers to compare against.
 */
export function generateMarchReconciliationFixtures(params: {
  merchantId: string;
  merchantKey: string;
  mdrBps: number;
  /** Alpha Retail's fee_schedules rows (ascending effective_from), so
   *  March captures book at the effective rate for their own occurred_at
   *  (the 245bps backfill) rather than the fixture mdrBps. */
  feeSchedules?: readonly FeeScheduleFixtureRow[];
}): MarchReconciliationFixtures {
  const { merchantId, merchantKey, mdrBps, feeSchedules = [] } = params;
  const rng = createRng(MARCH_RECON_RNG_SEED);

  const transactions: GeneratedTransaction[] = [];
  const ledgerGroups: LedgerGroup[] = [];

  BOUNDARY_RESIDUES.forEach((residue, i) => {
    const base = rng.int(500, 49_999) * 10;
    const capturedFils = toFils(base + residue);
    const occurredAt = new Date(
      BOUNDARY_WINDOW_START_MS + rng.int(0, BOUNDARY_WINDOW_SPAN_SECONDS - 1) * 1_000,
    );
    const id = rng.uuid();
    const reference = `${merchantKey}-mar-boundary-${String(i + 1).padStart(4, "0")}`;
    const acquirerReference = `acq_${rng.uuid()}`;

    transactions.push({
      id,
      merchantId,
      status: "captured",
      amountFils: capturedFils,
      capturedFils,
      reference,
      acquirerReference,
      occurredAt,
    });
    ledgerGroups.push(
      buildCaptureLedgerGroup({
        transactionId: id,
        merchantId,
        mdrBps: effectiveMdrBpsAt(feeSchedules, occurredAt, mdrBps),
        capturedFils,
        occurredAt,
        reference,
        rng,
      }),
    );
  });

  const ordinary = generateTransactionsForMerchant({
    merchantId,
    merchantKey: `${merchantKey}-mar-ordinary`,
    mdrBps,
    feeSchedules,
    count: 24,
    rng,
    baseDate: new Date("2026-03-20T12:00:00Z"),
    dayRange: [0, 10],
  });
  transactions.push(...ordinary.transactions);
  ledgerGroups.push(...ordinary.ledgerGroups);

  return { transactions, ledgerGroups };
}
