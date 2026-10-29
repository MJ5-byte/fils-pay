# The Handover — FilsPay hackathon execution plan

Goal: find + fix every planted bug (with per-bug explanations), complete the
refunds feature end-to-end, decode the three transmissions, ship green.
Tier: HEAVY (security, money/DB, concurrency, full feature).

## Topology

Phases chained as separate runs (each run = one phase):

- Phase A INVESTIGATE (run `handover-investigate`): 15 read-only nodes, one
  per file domain, disjoint scopes, each writes a bounded report
  `<session-dir>/waves/handover/a-<node>.md` (<=5k tokens) mapping findings
  to the case-file bug list with file:line + repro command.
- Phase A2 SYNTHESIZE (run `handover-synthesize`): one aggregator reads all
  15 reports, dedupes, and writes the CONFIRMED BUG LEDGER
  `waves/handover/ledger.md` (bug id, severity, file:line, repro, proposed
  smallest fix, test impact). Orchestrator verifies each ledger line against
  the code before Phase C.
- Phase C FIX (run per cluster, started after ledger confirmed): one node
  per bug cluster with disjoint WRITE scopes; each node implements the
  smallest fix + updates bug-encoding tests + runs that package's tests;
  evidence captured in its report.
- Phase D FEATURE (refunds): core wiring kept by orchestrator
  (route+dispatcher eligibility+envelope+ledger correctness+discount-aware
  fee reversal), UI surfaces delegated (admin RefundDrawer, web UI),
  verification = booted stack + curl end-to-end + webhook receiver.
- Phase E SHIP: docker-compose up real-surface QA, full suite + typecheck
  green in one run, per-bug explanations doc, atomic commits, final report.

## Phase A nodes (category / scope)

| node | category | scope (read-only) |
|---|---|---|
| a-money | unspecified-low | packages/money/src/*, packages/money tests (fils, allocate_drift_known, parse_cents_compat, rounding_legacy), apps/settlement/internal/money |
| a-refunds | unspecified-low | routes/refunds.ts, refunds/*, payments/processRefund*, refundState, refundValidation, payments/idempotency* |
| a-signing | unspecified-low | webhooks/{dispatcher,sign,envelope,headers,transport,inboundVerify,secretCrypto,deliveries,testSend,archiveReplay}.ts + tests |
| a-callbacks | quick | acquirer/{callbacks,simulator,rng,types}.ts + routes/acquirerCallbacks.ts + tests |
| a-paymentlinks | unspecified-low | paymentLinks/*, routes/paymentLinks.ts + tests |
| a-auth | unspecified-low | auth/*, adminAuth/*, routes/auth.ts, routes/adminAuth.ts + tests |
| a-admin | unspecified-low | admin/* (incl. adjustmentImport, adjustmentCsvParsing, settlementClient, balanceAdjustments, credits, impersonation, transactionStatusRecompute, merchantFlags, reportingRebuild, bulkKyc, inviteCode, apiKeys, merchants), routes/admin*.ts + tests |
| a-core | unspecified-low | payments/{authorize,capture,void,discountAdjustment}, transactions/*, v1/*, fees/* + tests |
| a-settlement | unspecified-low | apps/settlement/internal/** (settlement, splits, scheduler, ledger, money, config, internalapi, cmd) + *_test.go |
| a-reporting | quick | apps/reporting/src/** + tests |
| a-db | quick | db/migrations/*.sql, db/migrate.ts |
| a-scripts | quick | scripts/*, docs/runbooks |
| a-seed | unspecified-low | db/seed/** incl. fixtures/transactions.ts (098c2de commit!), production_seed.sql, selfVerify |
| a-docs | quick | docs/adr/*, docs/*.md, CHANGELOG.md, AGENTS.md, CLAUDE.md, .cursorrules |
| a-infra | quick | ops/*, root package.json, Dockerfiles presence |

## Verification model

- Every fix node runs the package's real test command on ITS files and
  reports exit code + output tail.
- Full suite runs once at Phase E on the orchestrator side.
- Real-surface scenarios (C1/C2) run by the orchestrator against
  docker-compose stack + curl + a local webhook receiver.

## Delegation rationale

- Read-only investigation lanes have disjoint scopes and no dependency
  between them → parallel quick/unspecified-low nodes (fan-out, fan-in via
  the one synthesizer).
- Fixes serialize by write scope: no two nodes touch the same files; the
  ledger gates which fixes can start (dependent on investigation).
- Refunds feature = orchestrator-owned (cross-cutting correctness, needs the
  whole flow in view); UI surfaces delegated to visual/quick nodes after
  the API core is proven.
