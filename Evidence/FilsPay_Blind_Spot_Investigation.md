# FilsPay Blind Spot Investigation

Investigation opened 2026-10-30 (Asia/Bahrain). Static inspection only. Baseline HEAD: `2fe6ed05d8cd7624143ae17b01fa0cbe28482a01`; initial worktree clean. No application execution, tests, queries, dependencies, or source edits authorized or performed.

## Baseline and prior evidence

Read the existing `Evidence/bugs/Readme.md` (exact casing); initially no bug files or index entries exist. Preserve all registry instructions. Prior source report sections 21, 23, 24 independently inspected. Its 219 + 15 + 7 + 80 + 128 = 449 and 48.8% / 60.5% arithmetic is consistent. Current first-party tracked denominator is 450 excluding Evidence and package-lock.json. Added root AGENTS.md explains the difference; source code is unchanged compared with the runtime report baseline 3ac53d4. The prior report does not provide a complete per-file full-review inventory, so its 219 claim cannot be independently reconstructed. Frontend samples (~9) are incompletely named. The coverage inventory preserves unspecified prior status instead of inventing it. Old agent instruction files have not been opened.

Previous finding indexes: CODE-001..038, FINDING-001..032, runtime NEW-001/002 and EVID-001..027; forensic report concerns history/provenance, not additional application root causes. Prior reports are leads, never proof. Existing runtime report is incomplete (placeholder final sections); its isolated partial schema omits 0054 and 0055. No new finding will be labeled runtime reproduced without an exact matching existing artifact.

## Source coverage

Authoritative working inventory: [FilsPay_Blind_Spot_Coverage.csv](FilsPay_Blind_Spot_Coverage.csv), one row for each current tracked first-party file. `Target` marks the named priority blind spots (frontends, all tests, explicitly unread/partial API/reporting/settlement/seed/config files). Unknown earlier sample status is identified in `PreviousBasis`. Complete reads are credited only after actual examination. A final Markdown matrix will accompany the CSV.

## New findings

1. [BUG-001 — Merchant cookie not extended after OTP](bugs/bug-1-merchant-cookie-not-extended-after-otp.md): Medium, statically confirmed. Pending cookie keeps its ten-minute deadline after the database session becomes twelve hours. Independent of the known OTP predicate bypass and token fixation.

## Existing findings independently corroborated

New BUG-002: [Payment-link detail ignores pagination and cannot open older links](bugs/bug-2-older-payment-links-unreachable-in-dashboard.md) — Medium, STATICALLY CONFIRMED.
New BUG-003: [Reconciliation counts payout debits and subtracts the same batches again](bugs/bug-3-reconciliation-subtracts-paid-batches-twice.md) — Medium, STATICALLY CONFIRMED.
New BUG-004: [Settlement summary multiplies cumulative transaction amounts by capture-event count](bugs/bug-4-settlement-summary-multiplies-cumulative-captures.md) — Medium, STATICALLY CONFIRMED.
New BUG-005: [Pending reconciliation replaces actual capture fees with a different estimator](bugs/bug-5-pending-reconciliation-reprices-captures-with-default-mdr.md) — Medium, STATICALLY CONFIRMED.

Pending source review. Prior IDs are retained for deduplication.

## Test coverage weaknesses

Pending static test-to-implementation review. No tests will be executed or changed.

## Cross-component discoveries

- [BUG-014](bugs/bug-14-zero-discount-events-allow-repeated-rebates.md): Zero-discount capture events let retries post a later rebate repeatedly (High, static).
- [BUG-015](bugs/bug-15-capture-replay-not-bound-to-transaction.md): Capture replay ignores the transaction ID and can credit from another tenant's event (High, static).
- [BUG-016](bugs/bug-16-transaction-csv-retains-formula-cells.md): Transaction CSV exports formula-prefixed references as spreadsheet formulas (Medium, static).
- [BUG-013](bugs/bug-13-single-merchant-cli-rebuild-never-persists.md): Single-merchant balance rebuild reports success without repairing the cache (Medium, static).
- [BUG-010](bugs/bug-10-used-webhook-endpoints-cannot-be-deleted.md): Webhook endpoint deletion fails once deliveries or archives reference it (Medium, static).
- [BUG-011](bugs/bug-11-admin-logout-leaves-impersonation-grant-active.md): Admin logout hides impersonation while its credential remains valid (Medium, static).
- [BUG-012](bugs/bug-12-ledger-activity-includes-exclusive-end-date.md): Recent ledger activity includes the entire exclusive end date (Low, static).
- [BUG-006](bugs/bug-6-dashboard-identity-rejects-impersonation.md): Merchant dashboard identity rejects valid impersonation grants (Medium, static).
- [BUG-007](bugs/bug-7-impersonation-opens-unregistered-web-root.md): View as merchant opens an unregistered frontend route (Low, static).
- [BUG-008](bugs/bug-8-stale-admin-merchant-detail-targets-new-route.md): Admin actions can target a different merchant than the displayed profile (High, static).
- [BUG-009](bugs/bug-9-bulk-kyc-retains-hidden-filter-selections.md): Bulk KYC retains hidden selections across filters and mischecks select-all (Medium, static).
Pending frontend/API/database contract tracing.

## Unresolved suspicions

None promoted at opening.

## Excluded files and remaining gaps

Generated SQL seed dump, dependency checksum/lock data, raw export datasets, and old agent instructions excluded. Previously reviewed core files will be read as dependencies of new hypotheses, not exhaustively repeated. Docs/ADRs previously reviewed by the documentation investigation are only reread when relevant. Full target inventory remains pending at opening.

## Preservation

Only new documentation under Evidence and append-only additions to the existing bug registry are permitted. Existing investigation reports will not be changed.

### Subsystem checkpoint — frontend contracts and settlement reporting

Merchant auth, checkout, transaction pages, payment-link pages, overview, reconciliation, shared clients/guards/helpers; admin auth, all operation pages and API wrappers have been read completely. Remaining frontend files are listed individually in the inventory. New BUG-001..009 documented immediately; all static (0 runtime claims). No application execution.

Corroborated prior findings without duplicate files: CODE-007 write-capable grants and missing capture/void role gate; CODE-011 cache-only corrections; CODE-030 rotation never revokes (UI falsely promises immediate revocation); CODE-031 bulk KYC status/review bypass; CODE-033 hidden test-mode transition; CODE-038 refund drawer entirely commented/unwired. Previously reported signed bhd rendering rejection is corroborated, and BUG-003 supplies an ordinary negative-gap trigger. Fee display chooses latest insertion, not effective schedule; this is corroboration of F07 / the finance case-file complaint rather than a new unique finding.

Test weaknesses confirmed so far: session tests skip browser cookie lifecycle and pending-session rejection; dashboard helper tests use only nonnegative money and explicitly lock UTC boundaries; fee display tests assert that a backfill wins; fee resolver fixture test returns successfully if seed data is absent; settlement tests duplicate Go settlement in TS, place payout debits outside their narrow reconciliation period, test only one capture per transaction for summary, and test pending only with the default MDR and an exact rounding amount. Future regression cases are specified in the individual bugs. No missing test is counted as an application defect.

### Subsystem checkpoint — named backend blind spots, configuration and seeds

All named unread/partial API modules, remaining settlement entrypoint/pool/status code and reporting configuration/database helpers inspected. Merchant/admin JSX, clients, types, routing and bootstrap reviewed; CSS excluded as presentation-only. Seed modules read in chunks (remaining transaction-fixture chunk tracked below). API fee estimator is reachable via reconciliation, contradicting CODE-038's dead-code label. API webhook reads are merchant-scoped and omit secrets; cursor encoders preserve PostgreSQL microseconds. The unused v1 route and receipt helper do not establish a reachable unauthenticated capture/receipt exposure. Saved-filter 50-row-cap claim is false (actual migration 0069 has no cap), but no quota-related security impact is asserted. Reporting integer config parsing silently accepts trailing units; rollback failure can mask an original error; record as operational leads, not inflated findings. Health readiness is boot-only, already documented by the earlier report.

Additional test weaknesses: webhook CRUD deletes an unused endpoint; receiver tests parse and re-canonicalize JSON, hiding CODE-029 raw-byte signature disagreement, and replay test explicitly asserts a fresh identity. Pure OTP tests prove shape/nonconstancy, not secure randomness or route budgets. Refund validation fixture precomputes headroom from authorized amounts, hiding CODE-009. Split tests use divisible totals only. The single-merchant balance helper test checks a returned sum, while only the all-merchant test checks persisted cache (BUG-013).
