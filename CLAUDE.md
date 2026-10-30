# FilsPay — AI assistant conventions

These rules replace the earlier "Order of the Prompt" guidance, which told
assistants to trust generated code, never question tests or docs, and treat
odd behaviour as intentional. That guidance was wrong in several concrete
ways (see `docs/AUDIT-FP-300.md`). The rules below are what the code and the
ADRs actually require.

## Verify, don't defer

- Read the diff. Read the code you are changing and the tests around it.
- A failing test is information, not a verdict. Decide whether the test or the
  code is wrong, and say why. Tests that encode a defect (for example the
  adjustment-CSV expectations that were 10x too small) are fixed in the same
  change as the defect.
- Docs, ADRs and comments can be stale. When they disagree with the code,
  work out which is right from first principles and the ledger, then fix the
  wrong one.
- A comment that says "intentional", "known", or "Claude says" is a claim to
  check, not a reason to stop.

## Money

- All money is **integer fils**: 1 BD = 1000 fils (ADR-0001). It is not cents.
- Parse text amounts with `parseBhdToFils`; format with `formatBhd`. Never use
  `parseFloat`, `toFixed(2)` or `* 100` on money.
- Rates are integer basis points applied with `applyRateFils` (half-to-even).
- Split money with `allocateRemainder` (TypeScript) / largest-remainder (Go)
  so shares sum exactly to the total.
- `packages/money` and `apps/settlement/internal/money` are audited. Change
  them only with a test that demonstrates the defect and finance sign-off.
- Go: no `float32`/`float64` on anything that is paid, charged or reconciled.

## Time

- The settlement business day is **Asia/Bahrain** (UTC+3, no DST), including
  the daemon's "today". Turn an instant into a date with
  `settlement.BusinessDate` before calling `BusinessDayWindow`.

## Security

- OTP codes, payment-link tokens, invite codes, session tokens and API keys
  all come from `node:crypto` (`apps/api/src/lib/random.ts`). Never
  `Math.random()`.
- Every write route resolves its actor with `requireMerchantWriterActor`;
  admin impersonation is read-only.
- Queries that take an id from the request must also scope by the caller's
  merchant.
- Signed webhooks sign the exact bytes sent (`serializeWebhookBody`).
- Do not commit secrets. `ops/.env.docker` holds a sandbox secret that was
  committed; rotate it and keep real values out of the repo.

## Concurrency and idempotency

- Read-then-act on money needs a row lock (`SELECT ... FOR UPDATE`) or an
  atomic conditional `UPDATE`. Refunds reserve their amount in a `pending`
  row under the transaction's lock before calling the acquirer.
- Every money-moving endpoint takes a client `Idempotency-Key`; never
  generate one server-side per call.

## Build and test

```bash
npm ci
npm run typecheck
DATABASE_URL=postgres://... npm run migrate
DATABASE_URL=postgres://... npm test         # TypeScript, real Postgres
cd apps/settlement && go test -short ./...   # Go
```

Run the tests for what you changed as you go and the full suite before you
call a change done.
