/** Static merchant fixtures, including the business-profile data
 *  onboarding/KYC needs.
 *  IDs are assigned deterministically at insert time by the seeded rng in
 *  generate.ts, not hardcoded here.
 *
 *  Every merchant_users row seeded from these fixtures shares one fixed dev
 *  password — `SEED_USER_PASSWORD` in `../generate.ts` (currently
 *  `"FilsPaySeed!2026"`) — so manual/QA testing can log in as any of them.
 *  It is hashed with the real `hashPassword()` before being written; never
 *  a real credential. */

export interface MerchantUserFixture {
  email: string;
  role: "owner" | "finance" | "support";
}

export interface BusinessProfileFixture {
  legalName: string;
  registrationNumber: string;
  businessType: "sole_proprietorship" | "llc" | "partnership" | "public_company" | "other";
  country: string;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postalCode?: string;
}

/** One fee_schedules row: a negotiated rate effective from an instant. */
export interface FeeScheduleFixture {
  /** ISO instant the rate becomes effective (fee_schedules.effective_from). */
  effectiveFrom: string;
  /** The negotiated rate from this instant on, in basis points. */
  mdrBps: number;
  /** fee_schedules.created_at — when the row was entered. Provide it when
   *  the scenario is about entry order (a later-entered backfill, the
   *  currentFeeScheduleDisplay case); omitted rows get the insert default
   *  (now()), exactly like a live entry. */
  createdAt?: string;
}

export interface MerchantFixture {
  key: string;
  displayName: string;
  mdrBps: number;
  /** This merchant's fee_schedules history, in ascending effective_from
   *  order — the rows generate.ts inserts, and the rates every seeded
   *  capture books its fee at for its own occurred_at (mirroring
   *  apps/settlement's EffectiveMdrBpsAt). Absent means no fee_schedules
   *  rows exist and every fee resolves to `mdrBps`. */
  feeSchedules?: readonly FeeScheduleFixture[];
  users: MerchantUserFixture[];
  businessProfile: BusinessProfileFixture;
  /** Negotiated reduction off this merchant's processing fee, basis points
   *  (db/migrations/0047). Absent means the column default, 0 — no
   *  negotiated agreement, which is every merchant onboarded without one. */
  negotiatedDiscountBps?: number;
  /** When set, this merchant is a sub-merchant of `splitParentKey` and
   *  receives `splitWeightBps` of that parent's net settlement payout
   *  (db/migrations/0045). A parent's children must sum to 10000. */
  splitParentKey?: string;
  splitWeightBps?: number;
  /** Marks a marketplace fixture: instead of the default ~34 transactions
   *  spread over a month, this merchant gets one-or-two captured orders on
   *  each of `marketplaceBusinessDays` consecutive settlement business
   *  days, with a real `transaction_events` capture timeline, so
   *  apps/settlement can actually be run against it day by day. */
  marketplaceBusinessDays?: number;
  /** Excludes this merchant's transactions from real settlement
   *  (apps/settlement/internal/settlement/batch.go's `test_mode = false`
   *  gate). Absent means the column default, false — a normal, live
   *  merchant. */
  testMode?: boolean;
}

export const MERCHANT_FIXTURES: readonly MerchantFixture[] = [
  {
    key: "alpha-retail",
    displayName: "Alpha Retail Co",
    mdrBps: 250, // 2.50%
    // Negotiated-rate history: 245bps backfilled for 2026-03-01 onward
    // (entered 2026-08-15, after the August row — the out-of-order entry
    // scenario currentFeeScheduleDisplay exercises), then 225bps from
    // 2026-08-01. Seeded captures book at the effective rate for their own
    // occurred_at, so the cutover rows are authoritative — not this
    // onboarding-era mdrBps: 245 for March activity, 225 for the August
    // fixture window.
    feeSchedules: [
      { effectiveFrom: "2026-03-01T00:00:00Z", mdrBps: 245, createdAt: "2026-08-15T00:00:00Z" },
      { effectiveFrom: "2026-08-01T00:00:00Z", mdrBps: 225, createdAt: "2026-08-01T00:00:00Z" },
    ],
    users: [
      { email: "owner@alpharetail.example", role: "owner" },
      { email: "finance@alpharetail.example", role: "finance" },
    ],
    businessProfile: {
      legalName: "Alpha Retail Co W.L.L.",
      registrationNumber: "CR-100001",
      businessType: "llc",
      country: "BH",
      contactEmail: "owner@alpharetail.example",
      contactPhone: "+973 1700 0001",
      addressLine1: "Building 12, Road 1706",
      city: "Manama",
      postalCode: "317",
    },
  },
  {
    key: "beta-digital",
    displayName: "Beta Digital Services",
    mdrBps: 180, // 1.80%
    // Negotiated-rate history: 180bps from launch (equal to the fixture
    // mdrBps, so nothing pre-cutover resolves differently), renegotiated
    // down to 165bps at the cutover instant (2026-09-06T12:00:00Z —
    // SEED_BASE_DATE + 5 days). Every seeded beta capture predates the
    // cutover and resolves to 180bps.
    feeSchedules: [
      { effectiveFrom: "2026-01-01T00:00:00Z", mdrBps: 180 },
      { effectiveFrom: "2026-09-06T12:00:00Z", mdrBps: 165 },
    ],
    users: [
      { email: "owner@betadigital.example", role: "owner" },
      { email: "support@betadigital.example", role: "support" },
      { email: "finance@betadigital.example", role: "finance" },
            // AM: login is scoped by merchantId, so the shared email always lands
            // in the merchant you picked. MK: DO NOT REMOVE, used for the
            // group-finance demo.
      // A second owner-level contact who was already registered at Alpha
      // Retail before joining Beta Digital's finance team — added at
      // onboarding time rather than issued a fresh address, since it's the
      // same person's existing work email.
      { email: "owner@alpharetail.example", role: "owner" },
    ],
    businessProfile: {
      legalName: "Beta Digital Services S.P.C.",
      registrationNumber: "CR-100002",
      businessType: "sole_proprietorship",
      country: "BH",
      contactEmail: "owner@betadigital.example",
      contactPhone: "+973 1700 0002",
      addressLine1: "Office 44, Seef Tower",
      city: "Seef",
      postalCode: "436",
    },
  },
  {
    key: "gamma-hospitality",
    displayName: "Gamma Hospitality Group",
    mdrBps: 320, // 3.20%
    // Still on the sandbox: this merchant's activity must stay out of real
    // settlement runs until they go live.
    testMode: true,
    users: [
      { email: "owner@gammahospitality.example", role: "owner" },
      { email: "finance@gammahospitality.example", role: "finance" },
    ],
    businessProfile: {
      legalName: "Gamma Hospitality Group B.S.C.",
      registrationNumber: "CR-100003",
      businessType: "public_company",
      country: "BH",
      contactEmail: "owner@gammahospitality.example",
      contactPhone: "+973 1700 0003",
      addressLine1: "Marina Walk, Building 7",
      addressLine2: "Floor 3",
      city: "Manama",
      postalCode: "199",
    },
  },
  {
    // The high-volume fixture: a B2B wholesaler with large tickets and a
    // long settlement history (see HIGH_VOLUME_* in ../generate.ts).
    key: "delta-wholesale",
    displayName: "Delta Wholesale Traders",
    mdrBps: 210, // 2.10%
    users: [
      { email: "owner@deltawholesale.example", role: "owner" },
      { email: "finance@deltawholesale.example", role: "finance" },
    ],
    businessProfile: {
      legalName: "Delta Wholesale Traders W.L.L.",
      registrationNumber: "CR-100004",
      businessType: "llc",
      country: "BH",
      contactEmail: "owner@deltawholesale.example",
      contactPhone: "+973 1700 0004",
      addressLine1: "Warehouse 9, Sitra Industrial Area",
      city: "Sitra",
      postalCode: "605",
    },
  },
  {
    // The marketplace operator of record. Its settlement proceeds are split
    // across the three sub-merchant storefronts below rather than paid to
    // it as a lump sum, and it negotiated a platform discount for the whole
    // marketplace as part of onboarding.
    key: "delta-marketplace",
    displayName: "Delta Marketplace Bahrain",
    mdrBps: 275, // 2.75%
    negotiatedDiscountBps: 1250, // 12.50%, agreed at onboarding against marketplace volume
    marketplaceBusinessDays: 140,
    users: [
      { email: "owner@deltamarketplace.example", role: "owner" },
      { email: "finance@deltamarketplace.example", role: "finance" },
    ],
    businessProfile: {
      legalName: "Delta Marketplace Bahrain W.L.L.",
      registrationNumber: "CR-100008",
      businessType: "llc",
      country: "BH",
      contactEmail: "owner@deltamarketplace.example",
      contactPhone: "+973 1700 0004",
      addressLine1: "Bahrain Bay, Building 1398",
      addressLine2: "Floor 9",
      city: "Manama",
      postalCode: "428",
    },
  },
  {
    key: "delta-child-a",
    displayName: "Coral Bay Traders",
    mdrBps: 275,
    splitParentKey: "delta-marketplace",
    splitWeightBps: 5000, // 50.00%
    users: [{ email: "owner@coralbaytraders.example", role: "owner" }],
    businessProfile: {
      legalName: "Coral Bay Traders W.L.L.",
      registrationNumber: "CR-100005",
      businessType: "llc",
      country: "BH",
      contactEmail: "owner@coralbaytraders.example",
      contactPhone: "+973 1700 0005",
      addressLine1: "Shop 18, Coral Bay Plaza",
      city: "Muharraq",
      postalCode: "228",
    },
  },
  {
    key: "delta-child-b",
    displayName: "Palm Grove Retail",
    mdrBps: 275,
    splitParentKey: "delta-marketplace",
    splitWeightBps: 3000, // 30.00%
    users: [{ email: "owner@palmgroveretail.example", role: "owner" }],
    businessProfile: {
      legalName: "Palm Grove Retail S.P.C.",
      registrationNumber: "CR-100006",
      businessType: "sole_proprietorship",
      country: "BH",
      contactEmail: "owner@palmgroveretail.example",
      contactPhone: "+973 1700 0006",
      addressLine1: "Unit 4, Palm Grove Centre",
      city: "Riffa",
      postalCode: "913",
    },
  },
  {
    key: "delta-child-c",
    displayName: "Seef Kiosk Partners",
    mdrBps: 275,
    splitParentKey: "delta-marketplace",
    splitWeightBps: 2000, // 20.00%
    users: [{ email: "owner@seefkiosk.example", role: "owner" }],
    businessProfile: {
      legalName: "Seef Kiosk Partners W.L.L.",
      registrationNumber: "CR-100007",
      businessType: "partnership",
      country: "BH",
      contactEmail: "owner@seefkiosk.example",
      contactPhone: "+973 1700 0007",
      addressLine1: "Kiosk 7, Seef Mall",
      city: "Seef",
      postalCode: "436",
    },
  },
];
