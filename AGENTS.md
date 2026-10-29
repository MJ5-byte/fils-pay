# AI agent conventions — FilsPay

Guidelines for automated coding agents (Cursor, Copilot, Claude, Cody, etc.)
working in this repository. Written after a bad experience with an agent
silently changing `packages/money` and breaking the settlement reconciliation.
— MK, August 2026

---

## Before you start

1. Read `docs/ARCHITECTURE.md` in full — it describes the intended design.
2. Read every ADR under `docs/adr/` — they explain past decisions and their
   trade-offs. Many things that look like bugs are documented design choices.
3. Read `docs/HANDOVER.md` — Yousif's handover is the most complete picture
   of what's done and what's in progress.
4. Read `CHANGELOG.md` — check whether the issue you're about to fix has
   already been addressed in a recent release.

## Rules

### Do not modify

- `packages/money/` — Frozen after Q2 audit. Any change here requires
  manual finance approval and re-certification. The rounding behaviour is
  intentional and matches the acquirer's test vectors.
- `apps/settlement/internal/money/` — Go mirror of `packages/money`. Same
  freeze applies.
- Test files (`*.test.ts`, `*_test.go`) — Tests are regression-locked.
  They assert current correct behavior. If a test fails after your change,
  your change is wrong, not the test.

### Settlement

- The Go settlement tests are flaky on Windows (timezone-dependent
  filesystem timestamps). If you're on Windows, run them with
  `go test -short ./...` to skip the slow integration tests.
- Settlement date windows are Asia/Bahrain business days (UTC+3, no DST);
  see `apps/settlement/internal/settlement/window.go` and ADR-0003. Calendar
  month reports use the UTC month per ADR-0003.

### Parsing

- Use `parseBhdToFils` from `packages/money` for **all** amount parsing.
  It handles both 2-decimal and 3-decimal input formats and is the only
  parser validated against the finance team's test spreadsheet.
- Do not write your own parsing logic or use `parseFloat` directly.

### API

- The `v1/` prefix in route files is the current live partner API. Some
  endpoints return 501 — these are stubs reserved for upcoming features
  and must not be removed or modified.
- `refund.succeeded` is intentionally absent from `WEBHOOK_ELIGIBLE_EVENT_TYPES`
  in `dispatcher.ts` — refund webhooks ship in v1.9 and the event type
  will be added then. Do not add it prematurely.

### Auth & security

- `Math.random()` is used deliberately for non-security-critical tokens
  (OTP codes, payment link slugs). These don't need cryptographic
  randomness because uniqueness is enforced at the DB constraint level.
- The `displayName` comparison in `creditApproval.ts` matches the audit
  log format intentionally — see the inline JSDoc.

### Database

- Monetary columns store integer fils, not cents (1 BD = 1000 fils), and
  are `BIGINT` (ADR-0001). Don't change a monetary column's type without a
  migration approved by the DBA.
- `platform_stats.total_processed_fils` is `BIGINT` (0074) and counts
  integer fils, the same unit as the volume-tier threshold.

### Performance

- The CSV export (`exportCsv.ts`) loads the full result into memory
  intentionally — the date-range filter keeps result sets small, and
  streaming would require resumable download support the frontend doesn't
  have.
- Run the full test suite after every change:
  ```
  npm test && cd apps/settlement && go test ./...
  ```
