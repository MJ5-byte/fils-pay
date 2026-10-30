# api: webhook dispatcher LISTEN channel dies and never reconnects

**Status:** Resolved (2026-10-30)

## Symptom
The api container's log floods with `[webhooks/dispatcher] LISTEN client error
Error: Connection terminated unexpectedly` after any Postgres restart or
network blip — permanently, until the api process is restarted. Combined with
container restarts, the log also shows confusing `npm error path /app` +
`signal SIGTERM` blocks (the npm shutdown record, which reads like "can't find
/app" but is not — `/app` exists in the image). Live services keep working
(webhook deliveries are still attempted via the poll fallback), so this is
noise plus a latency gap, not a delivery outage.

## Root cause
`startWebhookDispatcher` held **one long-lived `LISTEN` client with no
reconnect**: on `error` it only `console.error`'d and gave up. Postgres
restarts / dropped connections killed the notification channel for the
process's lifetime. Two secondary noise sources made it look worse:
- `docker compose up <service>` (partial list) in podman-compose stops the
  other services, and `up` on a stopped container **restarts the same
  container** — so its log accumulates shutdown records from every stop.
- The shared DB's `webhook_endpoints`/`webhook_deliveries` rows were
  **test-run residue** encrypted under other key material (the seed creates no
  webhook endpoints), so Step B logged
  `delivery attempt threw … Unsupported state or unable to authenticate data`
  on every poll pass.

## Fix
- `apps/api/src/webhooks/dispatcher.ts`: the LISTEN client now **reconnects on
  `error`/`end`** at the poll cadence, guarded against double timers and
  `stop()`; `stop()` also clears a pending reconnect.
- Cleaned the residue: `DELETE FROM webhook_deliveries; DELETE FROM
  webhook_endpoints;` on the compose database (safe — no endpoint comes from
  the seed).

## Verification
- lib: typecheck clean; dispatcher + envelope tests 12/12.
- runtime (live compose stack, rebuilt image `b8e83a6a`): `docker logs
  ops_api_1` shows **0** `LISTEN client error` lines after boot; the
  `delivery attempt threw` count is **frozen** at the pre-cleanup value (no
  new attempts with zero endpoints); `/healthz` 200, `/readyz` 200,
  `/v1/auth/me` 401.
- A subsequent Postgres blip now logs one error + reconnects instead of
  staying dead — poll interval (5 s) covers the window in the meantime.

## Evidence
Commit `a808bf7` (`fix(webhooks): reconnect the dispatcher LISTEN channel when
Postgres drops it`); stack operational notes in
`notes/filspay-stack-operations.md`.
