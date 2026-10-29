import { createHash } from "node:crypto";
import { type Fils, ZERO_FILS, applyRateFils, bankersRoundDiv, subtractFils, toFils } from "@filspay/money";
import type { SeededRng } from "../rng.js";

export type TransactionStatus = "authorized" | "captured" | "partially_captured" | "voided";

/** Chart-of-accounts codes a seeded capture event posts to. */
export type LedgerAccountId =
  | "merchant_payable"
  | "platform_fee_revenue"
  | "card_scheme_clearing"
  | "platform_cash";

export interface GeneratedTransaction {
  id: string;
  merchantId: string;
  status: TransactionStatus;
  amountFils: Fils;
  capturedFils: Fils;
  reference: string;
  acquirerReference: string;
  occurredAt: Date;
}

export interface LedgerLeg {
  accountId: LedgerAccountId;
  direction: "debit" | "credit";
  amountFils: Fils;
}

export interface LedgerGroup {
  entryGroupId: string;
  transactionId: string;
  merchantId: string;
  occurredAt: Date;
  description: string;
  legs: LedgerLeg[];
}

export interface GenerateTransactionsResult {
  transactions: GeneratedTransaction[];
  /** One ledger group per capture event. Authorized (not yet captured) and
   *  voided (never captured) transactions never move money, so they never
   *  contribute a group here. */
  ledgerGroups: LedgerGroup[];
}

/** One fee_schedules row the seed books fees against (in ascending
 *  effective_from order, as apps/settlement's LoadFeeSchedules returns). */
export interface FeeScheduleFixtureRow {
  effectiveFrom: string;
  mdrBps: number;
}

/**
 * Resolves the fee rate in effect at `asOf` from a merchant's fee_schedules
 * history — the newest row whose effective_from has arrived, else
 * `fallbackMdrBps` (merchants.mdr_bps). Mirrors apps/settlement's
 * EffectiveMdrBpsAt (fee_schedule.go) exactly, so a seeded capture books its
 * fee at the same rate a live CloseBatch resolves for the same occurred_at
 * and the seeded ledger/settlement batches reconcile with the schedule.
 */
export function effectiveMdrBpsAt(
  schedules: readonly FeeScheduleFixtureRow[],
  asOf: Date,
  fallbackMdrBps: number,
): number {
  for (let i = schedules.length - 1; i >= 0; i--) {
    const schedule = schedules[i];
    if (schedule !== undefined && Date.parse(schedule.effectiveFrom) <= asOf.getTime()) {
      return schedule.mdrBps;
    }
  }
  return fallbackMdrBps;
}

// Weighted toward captured, with a healthy share of partial captures and a
// few authorized-but-not-yet-captured and voided transactions, so the seed
// exercises every status the money model cares about.
const STATUS_POOL: readonly TransactionStatus[] = [
  "captured",
  "captured",
  "captured",
  "captured",
  "partially_captured",
  "partially_captured",
  "authorized",
  "voided",
];

/**
 * Generates `count` transactions for one merchant, plus the paired
 * double-entry ledger group for every transaction that actually captured
 * money (fully or partially). `baseDate` is the deterministic "now" the
 * generated `occurred_at` timestamps are spread backward from.
 */
export function generateTransactionsForMerchant(params: {
  merchantId: string;
  merchantKey: string;
  mdrBps: number;
  /** This merchant's fee_schedules rows (ascending effective_from). When
   *  present, each capture books its fee at the rate effective for its own
   *  occurred_at (mirroring CloseBatch) instead of the flat fixture
   *  mdrBps. */
  feeSchedules?: readonly FeeScheduleFixtureRow[];
  count: number;
  rng: SeededRng;
  baseDate: Date;
  /** [minDaysBack, maxDaysBack] before baseDate, inclusive both ends.
   *  Defaults to the original full-month spread every existing caller
   *  relies on. */
  dayRange?: readonly [number, number];
}): GenerateTransactionsResult {
  const { merchantId, merchantKey, mdrBps, feeSchedules = [], count, rng, baseDate, dayRange = [0, 29] as const } = params;
  const [minDaysBack, maxDaysBack] = dayRange;

  const transactions: GeneratedTransaction[] = [];
  const ledgerGroups: LedgerGroup[] = [];

  for (let i = 0; i < count; i++) {
    const status = rng.pick(STATUS_POOL);
    const amountFils = toFils(rng.int(5_000, 500_000)); // 5.000 - 500.000 BD authorized
    const occurredAt = new Date(
      baseDate.getTime() - rng.int(minDaysBack, maxDaysBack) * 86_400_000 - rng.int(0, 86_399) * 1_000,
    );
    const reference = `${merchantKey}-txn-${String(i + 1).padStart(4, "0")}`;

    let capturedFils: Fils;
    if (status === "captured") {
      capturedFils = amountFils;
    } else if (status === "partially_captured") {
      // Capture some realistic fraction (40%-90%) of the authorized amount,
      // computed via integer bigint math (bankersRoundDiv), never a float
      // multiply, so captured_fils <= amount_fils always holds exactly.
      const pct = rng.int(40, 90);
            // FH: should this be Math.round to match the acquirer (half-up)? AI
            // flagged banker's rounding as a likely mismatch. MK: leave it.
      capturedFils = toFils(bankersRoundDiv(BigInt(amountFils) * BigInt(pct), 100n));
    } else {
      // 'authorized' (not yet captured) and 'voided' (never captured) both
      // have zero captured_fils and therefore move zero money.
      capturedFils = ZERO_FILS;
    }

    const id = rng.uuid();
    // Every real authorize() call persists the acquirer's own reference
    // (db/migrations/0017); the seed generator produces one deterministically
    // per fixture transaction, in the same "acq_<uuid>" shape the real
    // AcquirerSimulator uses, so seed data isn't an exception to that
    // NOT NULL column.
    const acquirerReference = `acq_${rng.uuid()}`;
    transactions.push({ id, merchantId, status, amountFils, capturedFils, reference, acquirerReference, occurredAt });

    if (capturedFils > 0) {
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
    }
  }

  return { transactions, ledgerGroups };
}

/**
 * Generates one business day's worth of fully-captured transactions for the
 * high-volume merchant fixture, plus the paired ledger group for each.
 * Every transaction is `captured` in full — no partials, authorizations or
 * voids — because this fixture exists to give one merchant a long run of
 * ordinary, settled trading days, not to exercise the status machine (the
 * three small merchants already do that).
 *
 * `occurredAt` is spread across Asia/Bahrain business hours (09:00-17:00
 * local = 06:00-14:00 UTC) of `dateStr`, so every event lands squarely
 * inside that calendar date's Bahrain-local day with hours to spare on
 * either side — never near a boundary where a reader's day-bucketing
 * convention could change which day it belongs to.
 */
export function generatePeakDay(params: {
  merchantId: string;
  merchantKey: string;
  mdrBps: number;
  count: number;
  minAmountFils: number;
  maxAmountFils: number;
  dateStr: string;
  daySequence: number;
  rng: SeededRng;
}): GenerateTransactionsResult {
  const { merchantId, merchantKey, mdrBps, count, minAmountFils, maxAmountFils, dateStr, daySequence, rng } = params;

  const transactions: GeneratedTransaction[] = [];
  const ledgerGroups: LedgerGroup[] = [];
  const dayStart = new Date(`${dateStr}T06:00:00Z`).getTime();

  for (let i = 0; i < count; i++) {
    const amountFils = toFils(rng.int(minAmountFils, maxAmountFils));
    const occurredAt = new Date(dayStart + rng.int(0, 8 * 60 * 60 - 1) * 1_000);
    const reference = `${merchantKey}-d${String(daySequence).padStart(3, "0")}-txn-${String(i + 1).padStart(4, "0")}`;
    const id = rng.uuid();
    const acquirerReference = `acq_${rng.uuid()}`;

    transactions.push({
      id,
      merchantId,
      status: "captured",
      amountFils,
      capturedFils: amountFils,
      reference,
      acquirerReference,
      occurredAt,
    });
    ledgerGroups.push(
      buildCaptureLedgerGroup({ transactionId: id, merchantId, mdrBps, capturedFils: amountFils, occurredAt, reference, rng }),
    );
  }

  return { transactions, ledgerGroups };
}

/** The marketplace's published basket totals, in fils (14.100 BD through
 *  233.950 BD). A marketplace checkout charges a basket total, not an
 *  arbitrary amount, so its seeded order flow draws from a fixed catalogue
 *  rather than a uniform random range. */
const MARKETPLACE_ORDER_TOTALS_FILS: readonly number[] = [
  14_100, 27_400, 41_950, 63_550, 78_100, 92_650, 105_950, 127_550, 142_100, 169_950, 195_300, 233_950,
];

/** One capture event on the transaction timeline — the row
 *  `recordTransactionEvent` writes for a real capture, and the row
 *  apps/settlement's CloseBatch reads to build a settlement batch. */
export interface GeneratedCaptureEvent {
  transactionId: string;
  amountFils: Fils;
  /** The fee actually charged at capture time, i.e. the MDR fee less the
   *  merchant's negotiated discount off it — the value capture.ts records
   *  in `transaction_events.metadata.feeFils`. */
  feeFils: Fils;
  occurredAt: Date;
}

export interface GenerateMarketplaceOrdersResult extends GenerateTransactionsResult {
  captureEvents: GeneratedCaptureEvent[];
}

/**
 * Generates a marketplace merchant's daily order flow: one or two orders,
 * each captured in full at fulfilment, on each of the `businessDayCount`
 * settlement business days ending the day before `baseDate`. Unlike
 * `generateTransactionsForMerchant` above, this also produces the
 * `transaction_events` capture timeline — this is the one fixture whose
 * settlement batches are meant to be produced by actually running
 * apps/settlement over the seeded data, and CloseBatch reads that timeline.
 *
 * Every timestamp is 09:00 UTC, i.e. midday Asia/Bahrain, so an order's
 * settlement business day is unambiguously the calendar date it is dated
 * on, in the timezone `BusinessDayWindow` uses.
 */
export function generateMarketplaceOrdersForMerchant(params: {
  merchantId: string;
  merchantKey: string;
  mdrBps: number;
  discountBps: number;
  businessDayCount: number;
  rng: SeededRng;
  baseDate: Date;
}): GenerateMarketplaceOrdersResult {
  const { merchantId, merchantKey, mdrBps, discountBps, businessDayCount, rng, baseDate } = params;

  const transactions: GeneratedTransaction[] = [];
  const ledgerGroups: LedgerGroup[] = [];
  const captureEvents: GeneratedCaptureEvent[] = [];
  let orderNumber = 0;

  for (let dayOffset = businessDayCount; dayOffset >= 1; dayOffset--) {
    const occurredAt = new Date(
      Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() - dayOffset, 9, 0, 0),
    );

    const ordersToday = rng.int(1, 2);
    for (let n = 0; n < ordersToday; n++) {
      orderNumber += 1;
      const amountFils = toFils(rng.pick(MARKETPLACE_ORDER_TOTALS_FILS));
      const id = rng.uuid();
      const reference = `${merchantKey}-order-${String(orderNumber).padStart(4, "0")}`;

      transactions.push({
        id,
        merchantId,
        status: "captured",
        amountFils,
        capturedFils: amountFils,
        reference,
        acquirerReference: `acq_${rng.uuid()}`,
        occurredAt,
      });

      // Capture-time fee: the MDR, then the merchant's negotiated discount
      // off that fee — the exact pair of postings capture.ts and
      // discountAdjustment.ts leave behind, folded into one balanced group
      // the same way every other seeded capture is.
      const feeBeforeDiscount = applyRateFils(amountFils, mdrBps);
      const feeFils = subtractFils(feeBeforeDiscount, applyRateFils(feeBeforeDiscount, discountBps));
      const merchantNet = subtractFils(amountFils, feeFils);

      const legs: LedgerLeg[] = [
        { accountId: "card_scheme_clearing", direction: "debit", amountFils },
        { accountId: "merchant_payable", direction: "credit", amountFils: merchantNet },
      ];
      if (feeFils > 0) {
        legs.push({ accountId: "platform_fee_revenue", direction: "credit", amountFils: feeFils });
      }

      ledgerGroups.push({
        entryGroupId: rng.uuid(),
        transactionId: id,
        merchantId,
        occurredAt,
        description: `capture ${reference}`,
        legs,
      });

      captureEvents.push({ transactionId: id, amountFils, feeFils, occurredAt });
    }
  }

  return { transactions, ledgerGroups, captureEvents };
}

/** The instalment plan for each multi-capture fixture transaction, in fils.
 *  Fixed literals rather than `rng.int()` draws: the whole value of this
 *  fixture is that its totals are known exactly by inspection. */
const MULTI_CAPTURE_INSTALMENTS_FILS: readonly (readonly number[])[] = [
  [60_000, 40_000],
  [90_000, 60_000],
  [50_000, 30_000],
  [80_000, 70_000, 50_000],
  [70_000, 50_000],
];

/** A single trading day well clear of every other fixture's window, so a
 *  query scoped to it sees these transactions and nothing else. The first
 *  transaction authorizes at 09:00 UTC (midday Asia/Bahrain) and each
 *  subsequent one an hour later, so all of them sit squarely inside the
 *  Bahrain-local business day for this date with hours to spare. */
const MULTI_CAPTURE_DATE = "2026-08-26";
const MULTI_CAPTURE_FIRST_HOUR_UTC = 9;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A stable, version-4-shaped UUID derived from `name` by hashing. Every
 * other generator in this file draws its ids from the shared `SeededRng`,
 * which means inserting a new id-drawing generator between two existing
 * ones shifts every draw downstream of it and silently rewrites unrelated
 * fixtures. Deriving this fixture's ids from its own reference strings
 * keeps them fixed for a given seed run *and* leaves the shared stream
 * untouched, so this generator can be added, moved or removed without
 * perturbing anything else the seed produces.
 */
function stableUuid(name: string): string {
  const bytes = createHash("sha256").update(name).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One row on a multi-capture transaction's `transaction_events` timeline —
 *  the authorization, then one row per capture call. */
export interface GeneratedTimelineEvent {
  transactionId: string;
  eventType: "authorized" | "captured" | "partially_captured";
  /** NULL for 'authorized', which moves no money (migration 0018). */
  amountFils: Fils | null;
  feeFils: Fils | null;
  occurredAt: Date;
}

export interface GenerateMultiCaptureResult extends GenerateTransactionsResult {
  events: GeneratedTimelineEvent[];
}

/**
 * Generates a small set of transactions that were each drawn down over two
 * or three separate capture calls, together with the full
 * `transaction_events` timeline and the per-capture ledger groups a real
 * sequence of `captureTransaction()` calls would have left behind.
 *
 * The standard `generateTransactionsForMerchant` fixture captures every
 * transaction in a single shot and writes no event timeline at all, so
 * nothing else in the seed exercises the ordinary, real-world case where
 * one transaction's cumulative `captured_fils` is the sum of several
 * instalments that each have their own event row, their own fee and their
 * own balanced ledger group.
 */
export function generateInstalmentCaptures(params: {
  merchantId: string;
  merchantKey: string;
  mdrBps: number;
  /** As generateTransactionsForMerchant: effective-rate fee booking when
   *  the merchant has a fee_schedules history. */
  feeSchedules?: readonly FeeScheduleFixtureRow[];
}): GenerateMultiCaptureResult {
  const { merchantId, merchantKey, mdrBps, feeSchedules = [] } = params;

  const transactions: GeneratedTransaction[] = [];
  const ledgerGroups: LedgerGroup[] = [];
  const events: GeneratedTimelineEvent[] = [];

  MULTI_CAPTURE_INSTALMENTS_FILS.forEach((instalments, index) => {
    const reference = `${merchantKey}-multi-evt-${String(index + 1).padStart(4, "0")}`;
    const id = stableUuid(`${reference}:transaction`);
    const hour = pad2(MULTI_CAPTURE_FIRST_HOUR_UTC + index);
    const authorizedAt = new Date(`${MULTI_CAPTURE_DATE}T${hour}:00:00Z`);
    // The instalments always draw the authorization down in full, so the
    // authorized ceiling and the final captured total are the same figure
    // and the transaction ends up 'captured', not 'partially_captured'.
    const amountFils = toFils(instalments.reduce((sum, part) => sum + part, 0));

    transactions.push({
      id,
      merchantId,
      status: "captured",
      amountFils,
      capturedFils: amountFils,
      reference,
      acquirerReference: `acq_${stableUuid(`${reference}:acquirer`)}`,
      occurredAt: authorizedAt,
    });
    events.push({
      transactionId: id,
      eventType: "authorized",
      amountFils: null,
      feeFils: null,
      occurredAt: authorizedAt,
    });

    instalments.forEach((instalment, n) => {
      const occurredAt = new Date(`${MULTI_CAPTURE_DATE}T${hour}:${pad2(15 * (n + 1))}:00Z`);
      const capturedFils = toFils(instalment);
      // The fee is charged on the instalment actually captured, never on
      // the running total — the same per-call rule capture.ts applies — at
      // the rate effective for this call's occurred_at.
      const feeFils = applyRateFils(capturedFils, effectiveMdrBpsAt(feeSchedules, occurredAt, mdrBps));
      const merchantNet = subtractFils(capturedFils, feeFils);

      const legs: LedgerLeg[] = [
        { accountId: "card_scheme_clearing", direction: "debit", amountFils: capturedFils },
        { accountId: "merchant_payable", direction: "credit", amountFils: merchantNet },
      ];
      if (feeFils > 0) {
        legs.push({ accountId: "platform_fee_revenue", direction: "credit", amountFils: feeFils });
      }

      // One balanced group per capture call, not one per transaction: the
      // ledger timeline has to have as many entries as the event timeline
      // it journals, or the two stop agreeing about when money moved.
      ledgerGroups.push({
        entryGroupId: stableUuid(`${reference}:capture:${n + 1}`),
        transactionId: id,
        merchantId,
        occurredAt,
        description: `capture ${reference}`,
        legs,
      });

      events.push({
        transactionId: id,
        eventType: n === instalments.length - 1 ? "captured" : "partially_captured",
        amountFils: capturedFils,
        feeFils,
        occurredAt,
      });
    });
  });

  return { transactions, ledgerGroups, events };
}

export function buildCaptureLedgerGroup(args: {
  transactionId: string;
  merchantId: string;
  mdrBps: number;
  capturedFils: Fils;
  occurredAt: Date;
  reference: string;
  rng: SeededRng;
}): LedgerGroup {
  const { transactionId, merchantId, mdrBps, capturedFils, occurredAt, reference, rng } = args;

  const fee = applyRateFils(capturedFils, mdrBps);
  const merchantNet = subtractFils(capturedFils, fee);

  const legs: LedgerLeg[] = [
    { accountId: "card_scheme_clearing", direction: "debit", amountFils: capturedFils },
    { accountId: "merchant_payable", direction: "credit", amountFils: merchantNet },
  ];

  // A fee that rounds down to zero fils is not recorded — the ledger only
  // ever records legs that actually moved money, and every leg's
  // amount_fils must be strictly positive.
  if (fee > 0) {
    legs.push({ accountId: "platform_fee_revenue", direction: "credit", amountFils: fee });
  }

  return {
    entryGroupId: rng.uuid(),
    transactionId,
    merchantId,
    occurredAt,
    description: `capture ${reference}`,
    legs,
  };
}
