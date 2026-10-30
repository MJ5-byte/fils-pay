# Changelog

All notable changes to FilsPay. Dates are deploy dates (Asia/Bahrain).
Versions are the API image tag; settlement and reporting are versioned with
it. Format loosely follows Keep a Changelog.

## [Unreleased]

### Added
- Refunds: `POST /v1/refunds`, `POST /v1/merchants/:id/refunds`, `refund.succeeded` webhook, dashboard refund drawer (migrations 0073-0075).
- `CORS_ALLOWED_ORIGINS` for deployed frontends; `docs/DEPLOY.md`.

### Fixed
- Concurrent refunds could both pay out; payment links could double-charge or accept late payments; webhooks signed different bytes than they sent; acquirer callbacks were not de-duplicated.
- Fresh migrations (0054, 0055, 0072) now apply.
- Adjustment CSV amounts were 10x too small; weak randomness for OTP/slugs; impersonation could write; cross-merchant refund/cancel; Go net payout used float32.
- See `docs/AUDIT-FP-300.md`.

## [1.9.2] - 2026-09-12

### Changed
- Volume-tier threshold updated for the platform-wide discount (d69a813).
  No pricing change for existing merchants.
- Dependency bumps across the workspace.

### Fixed
- Config: settlement now reads `DATABASE_URL` consistently with the other
  services (b64cd3c).

## [1.9.1] - 2026-08-22

### Fixed
- Duplicate `settlement.paid` webhooks (incident 2026-08-21). Receivers
  should dedupe on `Webhook-Delivery-Id`.
- Reporting worker no longer holds an extra LISTEN connection after a
  reconnect (#398).

## [1.9.0] - 2026-07-21

### Added
- Acquirer callback notes (`acquirer_callback_notes`, migration 0051) and
  signed callback verification (`inboundVerify`).
- Reporting saved filters (migration 0069).

### Security
- Inbound acquirer callbacks are now signature-checked and deduplicated.

## [1.8.0] - 2026-06-24

### Added
- Transactions CSV export (`GET /v1/transactions/export`). Streams rows, so
  it is safe for large merchants on the 512 MB container.
- KYC document thumbnails.
- Webhook delivery archive and replay for support.

## [1.7.1] - 2026-06-09

### Added
- Admin: **Import adjustments** from finance's CSV sheets (BD amounts).
- Partial-batch payout corrections in settlement (76913d3).

### Fixed
- Net payout figure now derived once per batch, so the bank instruction,
  statement and report agree.

## [1.7.0] - 2026-06-03

### Added
- Admin: **Rebuild cached balances** (finance and above). Same rebuild as the
  `settlement rebuild-balances` CLI, exposed through the internal API.
- Admin: **Recalculate MDR** for a merchant and date range.
- Payout disbursement records (migration 0057).

## [1.6.0] - 2026-05-20

### Added
- Admin credits with second-approver workflow above the threshold.
- Admin: **Rebuild analytics**.
- Platform volume tier.

### Fixed
- Incident 2026-05-14: payment links could be captured more than once when
  the acquirer re-sent a callback. Callbacks are now deduplicated on
  `callbackId`.

## [1.5.0] - 2026-05-07

### Added
- Admin: bulk KYC approve.
- Admin: Adjust balance (support).

### Changed
- README money section rewritten for new hires.

## [1.4.0] - 2026-04-28

### Added
- `transactions.refunded_fils` (migration 0043) in preparation for refunds.
- Refunds: `processRefund`, `refundValidation`, `refundState` helpers and the
  dashboard `RefundDrawer` (behind a flag).

## [1.3.2] - 2026-04-09

### Fixed
- README typo.

## [1.3.1] - 2026-03-19

### Added
- Negotiated merchant discount (`negotiated_discount_bps`, migration 0047),
  applied after MDR at capture and settlement.
- Split settlement for marketplaces.

### Fixed
- March reconciliation: scheme rounding residue swept to suspense (one-off,
  `scripts/reconcile_march.ts`). March ties out.

## [1.3.0] - 2026-03-10

### Added
- Third-decimal scheme amount on export lines (`amount_3dp`, migration 0038)
  so the residue can be posted per line.

### Removed
- `amount_3dp` reverted the same week; migration number reused for KYC
  thumbnails.

## [1.2.1] - 2026-02-24

### Fixed
- Settlement report totals (hotfix).

## [1.2.0] - 2026-02-23

### Added
- Lifetime payout estimate for monitoring (migration 0040).

## [1.1.0] - 2026-01-18

### Added
- Payment links.
- Webhooks with HMAC signatures and replay.

## [1.0.0] - 2025-12-14

First production release: merchant onboarding with KYC, card capture and
void, daily settlement in Asia/Bahrain business days, scheme file export
with residue journaled at export, reporting read model.
