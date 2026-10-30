# FilsPay — Bug Consolidation and Merge Audit Report

## 1. Overview and Purpose

This document provides a comprehensive audit trail of the consolidation, deduplication, and standardization of all vulnerability and defect findings discovered during the FilsPay security audit. 

An initial wave produced 72 canonical bug reports, while an independent static Blind Spot Investigation documented 16 additional findings. Because both teams utilized numeric prefixes (`bug-1` to `bug-16`), file collisions occurred and several underlying defects were independently reported under different titles.

This audit details the exact mapping from every original source report to its canonical standardized report, documents all merge decisions, records backup cryptographic verification, and confirms repository integrity.

---

## 2. Evidence Preservation and Backup Verification

Before any modification or consolidation, an immutable backup snapshot was established:
- **Backup Directory**: `Evidence/bug-merge-backup/session-20261030-132215-142e0e29/`
- **Total Files Backed Up**: 89 files (88 bug reports + original `Readme.md`)
- **Manifest Location**: `Evidence/bug-merge-backup/session-20261030-132215-142e0e29/SHA256SUMS.txt`
- **Inventory Manifest**: `Evidence/bug-merge-backup/session-20261030-132215-142e0e29/inventory.json`
- **Integrity Status**: 100% verified. Every source file was hashed before and after copying; zero byte mismatches occurred.

---

## 3. Consolidation Summary Statistics

- **Total Original Bug Reports**: 88
- **Duplicate Reports Consolidated**: 4
- **Unique Canonical Bugs Established**: 84
- **Critical Severity**: 14
- **High Severity**: 44
- **Medium Severity**: 22
- **Low Severity**: 4
- **Verification Classifications**:
  - Runtime Reproduced: 13
  - Statically Confirmed: 71
  - Unverified / Disproven: 0

---

## 4. Semantic Duplicate Groups and Merge Decisions

The following four duplicate/subset groups were identified and consolidated into single canonical reports:

### Duplicate Group 1: Settlement Summary Capture Fan-Out Double-Counting
- **Merged Reports**:
  - `bug-35-settlement-summary-double-counts.md` (Legacy Bug 35)
  - `bug-4-settlement-summary-multiplies-cumulative-captures.md` (Blind Spot BUG-004)
- **Canonical Report**: [`BUG-072 — Settlement Summary Query Multiplies Cumulative Captures by Capture Event Count`](bug-072-settlement-summary-double-counts.md)
- **Technical Analysis**: Both reports examine `apps/api/src/settlement/query.ts:359-386` (specifically lines 366-377). The query joins `transactions` with `transaction_events` for `event_type = 'captured'`. While transaction count is deduplicated using `COUNT(DISTINCT id)`, `SUM(captured_fils)` sums the transaction's lifetime captured amount for every joined capture event. In multi-capture scenarios, gross captured volume is duplicated.
- **Merge Decision**: MERGED into BUG-072. The deep technical analysis, CTE traces, and test weaknesses from BUG-004 were unified with the performance context and clue references from Bug 35.

### Duplicate Group 2: Session Promotion Token Fixation and Cookie Expiry Mismatch
- **Merged Reports**:
  - `bug-5-session-token-not-rotated-on-otp.md` (Legacy Bug 5)
  - `bug-1-merchant-cookie-not-extended-after-otp.md` (Blind Spot BUG-001)
- **Canonical Report**: [`BUG-016 — Session Token Not Rotated on OTP Promotion and Cookie Expiry Not Extended`](bug-016-session-token-not-rotated-on-otp.md)
- **Technical Analysis**: Bug 5 identified session fixation in `apps/api/src/auth/sessions.ts:50-61` (promoting session flips `authenticated = true` without rotating bearer token) and explicitly noted: *"Merchant verify also never re-sets the cookie, so the browser maxAge stays at the 10-minute pending TTL while the server row is extended to 12 hours."* Blind Spot BUG-001 independently focused on this cookie expiration mechanism.
- **Merge Decision**: MERGED into BUG-016. Security vulnerability (token fixation) and availability defect (10-minute cookie drop) are unified into an authoritative end-to-end authentication lifecycle report.

### Duplicate Group 3: Cryptographic Insecurity in PRNG (`Math.random`) for Tokens and OTPs
- **Merged Reports**:
  - `bug-3-otp-insecure-rng.md` (Legacy Bug 3)
  - `bug-9-payment-link-token-insecure-rng.md` (Legacy Bug 9)
- **Canonical Report**: [`BUG-029 — Insecure PRNG (Math.random) Used for OTP Generation and Payment Link Tokens`](bug-029-otp-and-payment-link-insecure-rng.md)
- **Technical Analysis**: Bug 3's title and scope covered both OTP codes and payment-link tokens generated via `random.ts:1-16`. Bug 9 isolated the payment-link token aspect of the exact same helper (`randomFromAlphabet`).
- **Merge Decision**: MERGED into BUG-029. Both defects originate from the identical shared PRNG utility in `apps/api/src/lib/random.ts` that bypassed the available CSPRNG in `apps/api/src/lib/crypto.ts`.

### Duplicate Group 4: Schema Migration Failure Sequence and Broken View Join Key
- **Merged Reports**:
  - `bug-57-migrations-break-fresh-database.md` (Legacy Bug 57)
  - `bug-65-refund-summary-view-joins-wrong-id.md` (Legacy Bug 65)
- **Canonical Report**: [`BUG-014 — Fresh Database Migrations Fail at 0054/0055 and View 0072 Has Broken Join Key`](bug-014-migrations-break-fresh-database.md)
- **Technical Analysis**: Bug 57 item 3 explicitly documented that `db/migrations/0072_refund_merchant_summary.sql:14` incorrectly joins `JOIN transactions t ON t.id = r.id` instead of `r.transaction_id`. Bug 65 analyzed this exact join error in isolation. The original README explicitly annotated: *"AI (same join as Bug 57's 0072)"*.
- **Merge Decision**: MERGED into BUG-014. View 0072's broken join is consolidated into the canonical database migration defect report.

---

## 5. Partial Overlaps Kept Distinct

- **Bug 50 vs Bug 69 (Infrastructure / Compose)**:
  - `bug-50-committed-secret-and-broken-compose.md` (Canonical BUG-043): Covers security secrets exposure (`ops/.env.docker` committed) and 34-byte fallback webhook encryption key in `apps/api/src/config.ts`.
  - `bug-69-compose-missing-dockerfiles-and-token.md` (Canonical BUG-044): Covers Docker Compose build failure (`Dockerfile.node` / `Dockerfile.go` missing) and settlement daemon failure without `SETTLEMENT_INTERNAL_TOKEN`.
  - **Decision**: KEPT DISTINCT. They represent separate fixable concerns (secrets management vs container orchestration). Redundant key-length text was cross-referenced to BUG-043.

---

## 6. Old-to-New Mapping Table

Every original report is tracked below with its original ID, original file, assigned canonical ID, canonical file, and disposition action:

| Original File | Original ID | Canonical ID | Canonical File | Action |
|---|---|---|---|---|
| `bug-1-merchant-cookie-not-extended-after-otp.md` | BUG-001 (Blind Spot) | **BUG-016** | [`bug-016-session-token-not-rotated-on-otp.md`](bug-016-session-token-not-rotated-on-otp.md) | MERGED |
| `bug-1-merchant-otp-bypass.md` | Bug 1 | **BUG-001** | [`bug-001-merchant-otp-bypass.md`](bug-001-merchant-otp-bypass.md) | RENAMED |
| `bug-10-payment-link-leaks-api-key-hash.md` | Bug 10 | **BUG-022** | [`bug-022-payment-link-leaks-api-key-hash.md`](bug-022-payment-link-leaks-api-key-hash.md) | RENAMED |
| `bug-10-used-webhook-endpoints-cannot-be-deleted.md` | BUG-010 (Blind Spot) | **BUG-070** | [`bug-070-used-webhook-endpoints-cannot-be-deleted.md`](bug-070-used-webhook-endpoints-cannot-be-deleted.md) | STANDARDIZED |
| `bug-11-admin-logout-leaves-impersonation-grant-active.md` | BUG-011 (Blind Spot) | **BUG-060** | [`bug-060-admin-logout-leaves-impersonation-grant-active.md`](bug-060-admin-logout-leaves-impersonation-grant-active.md) | STANDARDIZED |
| `bug-11-discount-skipped-for-payment-links.md` | Bug 11 | **BUG-023** | [`bug-023-discount-skipped-for-payment-links.md`](bug-023-discount-skipped-for-payment-links.md) | RENAMED |
| `bug-12-ledger-activity-includes-exclusive-end-date.md` | BUG-012 (Blind Spot) | **BUG-084** | [`bug-084-ledger-activity-includes-exclusive-end-date.md`](bug-084-ledger-activity-includes-exclusive-end-date.md) | STANDARDIZED |
| `bug-12-refunds-route-returns-501.md` | Bug 12 | **BUG-027** | [`bug-027-refunds-route-returns-501.md`](bug-027-refunds-route-returns-501.md) | RENAMED |
| `bug-13-refund-more-than-captured.md` | Bug 13 | **BUG-007** | [`bug-007-refund-more-than-captured.md`](bug-007-refund-more-than-captured.md) | RENAMED |
| `bug-13-single-merchant-cli-rebuild-never-persists.md` | BUG-013 (Blind Spot) | **BUG-067** | [`bug-067-single-merchant-cli-rebuild-never-persists.md`](bug-067-single-merchant-cli-rebuild-never-persists.md) | STANDARDIZED |
| `bug-14-concurrent-refund-double-money-out.md` | Bug 14 | **BUG-008** | [`bug-008-concurrent-refund-double-money-out.md`](bug-008-concurrent-refund-double-money-out.md) | RENAMED |
| `bug-14-zero-discount-events-allow-repeated-rebates.md` | BUG-014 (Blind Spot) | **BUG-026** | [`bug-026-zero-discount-events-allow-repeated-rebates.md`](bug-026-zero-discount-events-allow-repeated-rebates.md) | STANDARDIZED |
| `bug-15-capture-replay-not-bound-to-transaction.md` | BUG-015 (Blind Spot) | **BUG-021** | [`bug-021-capture-replay-not-bound-to-transaction.md`](bug-021-capture-replay-not-bound-to-transaction.md) | STANDARDIZED |
| `bug-15-cross-merchant-refund.md` | Bug 15 | **BUG-003** | [`bug-003-cross-merchant-refund.md`](bug-003-cross-merchant-refund.md) | RENAMED |
| `bug-16-transaction-csv-retains-formula-cells.md` | BUG-016 (Blind Spot) | **BUG-062** | [`bug-062-transaction-csv-retains-formula-cells.md`](bug-062-transaction-csv-retains-formula-cells.md) | STANDARDIZED |
| `bug-16-void-does-not-reverse-authorization.md` | Bug 16 | **BUG-024** | [`bug-024-void-does-not-reverse-authorization.md`](bug-024-void-does-not-reverse-authorization.md) | RENAMED |
| `bug-17-capture-ignores-hold-expiry.md` | Bug 17 | **BUG-025** | [`bug-025-capture-ignores-hold-expiry.md`](bug-025-capture-ignores-hold-expiry.md) | RENAMED |
| `bug-18-capture-holds-db-txn-across-acquirer.md` | Bug 18 | **BUG-061** | [`bug-061-capture-holds-db-txn-across-acquirer.md`](bug-061-capture-holds-db-txn-across-acquirer.md) | RENAMED |
| `bug-19-csv-import-10x-too-small.md` | Bug 19 | **BUG-009** | [`bug-009-csv-import-10x-too-small.md`](bug-009-csv-import-10x-too-small.md) | RENAMED |
| `bug-2-older-payment-links-unreachable-in-dashboard.md` | BUG-002 (Blind Spot) | **BUG-077** | [`bug-077-older-payment-links-unreachable-in-dashboard.md`](bug-077-older-payment-links-unreachable-in-dashboard.md) | STANDARDIZED |
| `bug-2-otp-sent-to-other-merchant.md` | Bug 2 | **BUG-002** | [`bug-002-otp-sent-to-other-merchant.md`](bug-002-otp-sent-to-other-merchant.md) | RENAMED |
| `bug-20-net-payout-float32.md` | Bug 20 | **BUG-010** | [`bug-010-net-payout-float32.md`](bug-010-net-payout-float32.md) | RENAMED |
| `bug-21-scheme-export-rounding-always-over.md` | Bug 21 | **BUG-034** | [`bug-034-scheme-export-rounding-always-over.md`](bug-034-scheme-export-rounding-always-over.md) | RENAMED |
| `bug-22-recalculate-balances-wrong-source.md` | Bug 22 | **BUG-011** | [`bug-011-recalculate-balances-wrong-source.md`](bug-011-recalculate-balances-wrong-source.md) | RENAMED |
| `bug-23-balance-adjustment-cache-only.md` | Bug 23 | **BUG-038** | [`bug-038-balance-adjustment-cache-only.md`](bug-038-balance-adjustment-cache-only.md) | RENAMED |
| `bug-24-mdr-recalc-rewrites-paid-batches.md` | Bug 24 | **BUG-035** | [`bug-035-mdr-recalc-rewrites-paid-batches.md`](bug-035-mdr-recalc-rewrites-paid-batches.md) | RENAMED |
| `bug-25-split-payout-missing-fils.md` | Bug 25 | **BUG-030** | [`bug-030-split-payout-missing-fils.md`](bug-030-split-payout-missing-fils.md) | RENAMED |
| `bug-26-fee-display-wrong-schedule.md` | Bug 26 | **BUG-071** | [`bug-071-fee-display-wrong-schedule.md`](bug-071-fee-display-wrong-schedule.md) | RENAMED |
| `bug-27-daily-close-runs-at-3am.md` | Bug 27 | **BUG-036** | [`bug-036-daily-close-runs-at-3am.md`](bug-036-daily-close-runs-at-3am.md) | RENAMED |
| `bug-28-platform-volume-int32-overflow.md` | Bug 28 | **BUG-031** | [`bug-031-platform-volume-int32-overflow.md`](bug-031-platform-volume-int32-overflow.md) | RENAMED |
| `bug-29-lifetime-payout-estimate-float32.md` | Bug 29 | **BUG-063** | [`bug-063-lifetime-payout-estimate-float32.md`](bug-063-lifetime-payout-estimate-float32.md) | RENAMED |
| `bug-3-otp-insecure-rng.md` | Bug 3 | **BUG-029** | [`bug-029-otp-and-payment-link-insecure-rng.md`](bug-029-otp-and-payment-link-insecure-rng.md) | MERGED |
| `bug-3-reconciliation-subtracts-paid-batches-twice.md` | BUG-003 (Blind Spot) | **BUG-065** | [`bug-065-reconciliation-subtracts-paid-batches-twice.md`](bug-065-reconciliation-subtracts-paid-batches-twice.md) | STANDARDIZED |
| `bug-30-recompute-statuses-clears-test-mode.md` | Bug 30 | **BUG-012** | [`bug-012-recompute-statuses-clears-test-mode.md`](bug-012-recompute-statuses-clears-test-mode.md) | RENAMED |
| `bug-31-ts-and-go-fee-formulas-diverge.md` | Bug 31 | **BUG-032** | [`bug-032-ts-and-go-fee-formulas-diverge.md`](bug-032-ts-and-go-fee-formulas-diverge.md) | RENAMED |
| `bug-32-expire-holds-deletes-every-hold.md` | Bug 32 | **BUG-013** | [`bug-013-expire-holds-deletes-every-hold.md`](bug-013-expire-holds-deletes-every-hold.md) | RENAMED |
| `bug-33-seed-truncates-database.md` | Bug 33 | **BUG-054** | [`bug-054-seed-truncates-database.md`](bug-054-seed-truncates-database.md) | RENAMED |
| `bug-34-march-sweep-not-idempotent.md` | Bug 34 | **BUG-033** | [`bug-033-march-sweep-not-idempotent.md`](bug-033-march-sweep-not-idempotent.md) | RENAMED |
| `bug-35-settlement-summary-double-counts.md` | Bug 35 | **BUG-072** | [`bug-072-settlement-summary-double-counts.md`](bug-072-settlement-summary-double-counts.md) | MERGED |
| `bug-36-webhook-signature-mismatch.md` | Bug 36 | **BUG-045** | [`bug-045-webhook-signature-mismatch.md`](bug-045-webhook-signature-mismatch.md) | RENAMED |
| `bug-37-inbound-callback-hmac-reserialized.md` | Bug 37 | **BUG-046** | [`bug-046-inbound-callback-hmac-reserialized.md`](bug-046-inbound-callback-hmac-reserialized.md) | RENAMED |
| `bug-38-acquirer-callback-signature-optional.md` | Bug 38 | **BUG-047** | [`bug-047-acquirer-callback-signature-optional.md`](bug-047-acquirer-callback-signature-optional.md) | RENAMED |
| `bug-39-duplicate-acquirer-callback-notes.md` | Bug 39 | **BUG-048** | [`bug-048-duplicate-acquirer-callback-notes.md`](bug-048-duplicate-acquirer-callback-notes.md) | RENAMED |
| `bug-4-otp-attempt-limit-race-and-resend-reset.md` | Bug 4 | **BUG-015** | [`bug-015-otp-attempt-limit-race-and-resend-reset.md`](bug-015-otp-attempt-limit-race-and-resend-reset.md) | RENAMED |
| `bug-4-settlement-summary-multiplies-cumulative-captures.md` | BUG-004 (Blind Spot) | **BUG-072** | [`bug-072-settlement-summary-double-counts.md`](bug-072-settlement-summary-double-counts.md) | MERGED |
| `bug-40-duplicate-payout-notifications.md` | Bug 40 | **BUG-049** | [`bug-049-duplicate-payout-notifications.md`](bug-049-duplicate-payout-notifications.md) | RENAMED |
| `bug-41-payout-disbursement-recorded-by-webhook.md` | Bug 41 | **BUG-050** | [`bug-050-payout-disbursement-recorded-by-webhook.md`](bug-050-payout-disbursement-recorded-by-webhook.md) | RENAMED |
| `bug-42-webhook-replay-new-delivery-id.md` | Bug 42 | **BUG-068** | [`bug-068-webhook-replay-new-delivery-id.md`](bug-068-webhook-replay-new-delivery-id.md) | RENAMED |
| `bug-43-webhook-url-ssrf.md` | Bug 43 | **BUG-051** | [`bug-051-webhook-url-ssrf.md`](bug-051-webhook-url-ssrf.md) | RENAMED |
| `bug-44-api-key-rotation-does-not-revoke.md` | Bug 44 | **BUG-039** | [`bug-039-api-key-rotation-does-not-revoke.md`](bug-039-api-key-rotation-does-not-revoke.md) | RENAMED |
| `bug-45-second-approver-compares-display-name.md` | Bug 45 | **BUG-040** | [`bug-040-second-approver-compares-display-name.md`](bug-040-second-approver-compares-display-name.md) | RENAMED |
| `bug-46-credits-missing-role-check.md` | Bug 46 | **BUG-041** | [`bug-041-credits-missing-role-check.md`](bug-041-credits-missing-role-check.md) | RENAMED |
| `bug-47-impersonation-grants-write-access.md` | Bug 47 | **BUG-004** | [`bug-004-impersonation-grants-write-access.md`](bug-004-impersonation-grants-write-access.md) | RENAMED |
| `bug-48-kyc-pdf-check-uses-filename.md` | Bug 48 | **BUG-075** | [`bug-075-kyc-pdf-check-uses-filename.md`](bug-075-kyc-pdf-check-uses-filename.md) | RENAMED |
| `bug-49-bulk-kyc-approve-bypasses-review.md` | Bug 49 | **BUG-042** | [`bug-042-bulk-kyc-approve-bypasses-review.md`](bug-042-bulk-kyc-approve-bypasses-review.md) | RENAMED |
| `bug-5-pending-reconciliation-reprices-captures-with-default-mdr.md` | BUG-005 (Blind Spot) | **BUG-066** | [`bug-066-pending-reconciliation-reprices-captures-with-default-mdr.md`](bug-066-pending-reconciliation-reprices-captures-with-default-mdr.md) | STANDARDIZED |
| `bug-5-session-token-not-rotated-on-otp.md` | Bug 5 | **BUG-016** | [`bug-016-session-token-not-rotated-on-otp.md`](bug-016-session-token-not-rotated-on-otp.md) | MERGED |
| `bug-50-committed-secret-and-broken-compose.md` | Bug 50 | **BUG-057** | [`bug-057-committed-secret-and-broken-compose.md`](bug-057-committed-secret-and-broken-compose.md) | RENAMED |
| `bug-51-reporting-consumer-double-applies.md` | Bug 51 | **BUG-052** | [`bug-052-reporting-consumer-double-applies.md`](bug-052-reporting-consumer-double-applies.md) | RENAMED |
| `bug-52-reporting-scope-split-child-idor.md` | Bug 52 | **BUG-019** | [`bug-019-reporting-scope-split-child-idor.md`](bug-019-reporting-scope-split-child-idor.md) | RENAMED |
| `bug-53-transaction-search-ilike-full-scan.md` | Bug 53 | **BUG-073** | [`bug-073-transaction-search-ilike-full-scan.md`](bug-073-transaction-search-ilike-full-scan.md) | RENAMED |
| `bug-54-large-export-pagination-drops-rows.md` | Bug 54 | **BUG-053** | [`bug-053-large-export-pagination-drops-rows.md`](bug-053-large-export-pagination-drops-rows.md) | RENAMED |
| `bug-55-ledger-and-audit-not-immutable.md` | Bug 55 | **BUG-055** | [`bug-055-ledger-and-audit-not-immutable.md`](bug-055-ledger-and-audit-not-immutable.md) | RENAMED |
| `bug-56-non-apperror-exceptions-return-500.md` | Bug 56 | **BUG-079** | [`bug-079-non-apperror-exceptions-return-500.md`](bug-079-non-apperror-exceptions-return-500.md) | RENAMED |
| `bug-57-migrations-break-fresh-database.md` | Bug 57 | **BUG-014** | [`bug-014-migrations-break-fresh-database.md`](bug-014-migrations-break-fresh-database.md) | MERGED |
| `bug-58-reporting-export-summary-unauthenticated.md` | Bug 58 | **BUG-020** | [`bug-020-reporting-export-summary-unauthenticated.md`](bug-020-reporting-export-summary-unauthenticated.md) | RENAMED |
| `bug-59-credits-backdated-and-threshold-split.md` | Bug 59 | **BUG-043** | [`bug-043-credits-backdated-and-threshold-split.md`](bug-043-credits-backdated-and-threshold-split.md) | RENAMED |
| `bug-6-dashboard-identity-rejects-impersonation.md` | BUG-006 (Blind Spot) | **BUG-059** | [`bug-059-dashboard-identity-rejects-impersonation.md`](bug-059-dashboard-identity-rejects-impersonation.md) | STANDARDIZED |
| `bug-6-payment-link-paid-after-expiry.md` | Bug 6 | **BUG-005** | [`bug-005-payment-link-paid-after-expiry.md`](bug-005-payment-link-paid-after-expiry.md) | RENAMED |
| `bug-60-csv-import-applies-twice.md` | Bug 60 | **BUG-044** | [`bug-044-csv-import-applies-twice.md`](bug-044-csv-import-applies-twice.md) | RENAMED |
| `bug-61-settlement-close-any-date-is-final.md` | Bug 61 | **BUG-037** | [`bug-037-settlement-close-any-date-is-final.md`](bug-037-settlement-close-any-date-is-final.md) | RENAMED |
| `bug-62-daily-batch-stops-on-first-merchant.md` | Bug 62 | **BUG-064** | [`bug-064-daily-batch-stops-on-first-merchant.md`](bug-064-daily-batch-stops-on-first-merchant.md) | RENAMED |
| `bug-63-webhook-delivery-no-claim.md` | Bug 63 | **BUG-069** | [`bug-069-webhook-delivery-no-claim.md`](bug-069-webhook-delivery-no-claim.md) | RENAMED |
| `bug-64-admin-analytics-rebuild-double-counts.md` | Bug 64 | **BUG-074** | [`bug-074-admin-analytics-rebuild-double-counts.md`](bug-074-admin-analytics-rebuild-double-counts.md) | RENAMED |
| `bug-65-refund-summary-view-joins-wrong-id.md` | Bug 65 | **BUG-014** | [`bug-014-migrations-break-fresh-database.md`](bug-014-migrations-break-fresh-database.md) | MERGED |
| `bug-66-suspended-merchant-credentials-keep-working.md` | Bug 66 | **BUG-017** | [`bug-017-suspended-merchant-credentials-keep-working.md`](bug-017-suspended-merchant-credentials-keep-working.md) | RENAMED |
| `bug-67-refund-null-reason-sticks-idempotency-key.md` | Bug 67 | **BUG-028** | [`bug-028-refund-null-reason-sticks-idempotency-key.md`](bug-028-refund-null-reason-sticks-idempotency-key.md) | RENAMED |
| `bug-68-pgconn-settlement-overrides-database-url.md` | Bug 68 | **BUG-080** | [`bug-080-pgconn-settlement-overrides-database-url.md`](bug-080-pgconn-settlement-overrides-database-url.md) | RENAMED |
| `bug-69-compose-missing-dockerfiles-and-token.md` | Bug 69 | **BUG-058** | [`bug-058-compose-missing-dockerfiles-and-token.md`](bug-058-compose-missing-dockerfiles-and-token.md) | RENAMED |
| `bug-7-impersonation-opens-unregistered-web-root.md` | BUG-007 (Blind Spot) | **BUG-083** | [`bug-083-impersonation-opens-unregistered-web-root.md`](bug-083-impersonation-opens-unregistered-web-root.md) | STANDARDIZED |
| `bug-7-payment-link-double-charge.md` | Bug 7 | **BUG-006** | [`bug-006-payment-link-double-charge.md`](bug-006-payment-link-double-charge.md) | RENAMED |
| `bug-70-migration-runner-has-no-checksum.md` | Bug 70 | **BUG-081** | [`bug-081-migration-runner-has-no-checksum.md`](bug-081-migration-runner-has-no-checksum.md) | RENAMED |
| `bug-71-dashboard-date-filter-uses-utc-midnight.md` | Bug 71 | **BUG-076** | [`bug-076-dashboard-date-filter-uses-utc-midnight.md`](bug-076-dashboard-date-filter-uses-utc-midnight.md) | RENAMED |
| `bug-72-settlement-progress-divides-fils-by-10000.md` | Bug 72 | **BUG-082** | [`bug-082-settlement-progress-divides-fils-by-10000.md`](bug-082-settlement-progress-divides-fils-by-10000.md) | RENAMED |
| `bug-8-payment-link-cancel-cross-merchant.md` | Bug 8 | **BUG-018** | [`bug-018-payment-link-cancel-cross-merchant.md`](bug-018-payment-link-cancel-cross-merchant.md) | RENAMED |
| `bug-8-stale-admin-merchant-detail-targets-new-route.md` | BUG-008 (Blind Spot) | **BUG-056** | [`bug-056-stale-admin-merchant-detail-targets-new-route.md`](bug-056-stale-admin-merchant-detail-targets-new-route.md) | STANDARDIZED |
| `bug-9-bulk-kyc-retains-hidden-filter-selections.md` | BUG-009 (Blind Spot) | **BUG-078** | [`bug-078-bulk-kyc-retains-hidden-filter-selections.md`](bug-078-bulk-kyc-retains-hidden-filter-selections.md) | STANDARDIZED |
| `bug-9-payment-link-token-insecure-rng.md` | Bug 9 | **BUG-029** | [`bug-029-otp-and-payment-link-insecure-rng.md`](bug-029-otp-and-payment-link-insecure-rng.md) | MERGED |

---

## 7. Findings Not Merged (Separation Rationale)

1. **Authentication vs Tenant Isolation**:
   - `merchant-otp-bypass` (BUG-001) allows an attacker with a password to bypass OTP.
   - `otp-sent-to-other-merchant` (BUG-002) binds session/OTP to a completely different tenant.
   - *Rationale*: Distinct vulnerabilities in separate routes and session logic; kept separate.
2. **Payment Link Vulnerabilities**:
   - `payment-link-paid-after-expiry` (BUG-005): Expired invoice payment via client parameter spoofing.
   - `payment-link-double-charge` (BUG-006): Concurrent payment reservation race condition.
   - `payment-link-cancel-cross-merchant` (BUG-018): Tenant isolation breach in link cancellation.
   - *Rationale*: Independent flaws across validation, state machine, and authorization boundaries.
3. **Refund Vulnerabilities**:
   - `refund-more-than-captured` (BUG-007): Validation against authorized amount instead of captured amount.
   - `concurrent-refund-double-money-out` (BUG-008): Concurrency race allowing two refunds on the same authorization.
   - `cross-merchant-refund` (BUG-003): Missing tenant scoping on refund initiation.
   - *Rationale*: Three distinct failure modes in financial math, concurrency control, and multi-tenant isolation.
4. **Settlement and Reconciliation Equations**:
   - `reconciliation-subtracts-paid-batches-twice` (BUG-065): Math error in reconciliation query subtracting payout debits twice.
   - `pending-reconciliation-reprices-captures-with-default-mdr` (BUG-066): Recomputing fees with default MDR instead of event fee metadata.
   - *Rationale*: Independent query logic errors occurring at different phases of the settlement lifecycle.

---

## 8. Final Consistency Verification

- [x] All 88 original files inventoried and preserved in immutable backup.
- [x] SHA-256 hashes generated and verified for 100% of backed-up originals.
- [x] Exactly 84 unique canonical bugs created (`BUG-001` through `BUG-084`).
- [x] Every canonical report follows the standardized 17-section format.
- [x] All links in master `Readme.md` resolve to valid files.
- [x] No application source code, tests, or database migrations were modified.
- [x] Zero Git history or staging modifications performed.
