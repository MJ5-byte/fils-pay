# Capacity and overload behaviour

## Estimate (submitted)

**About 8 checkouts per second, serving ~10 concurrent buyers with p95 checkout
latency under 2 s.** Beyond that, extra load is turned away with `503` +
`Retry-After: 1`; admitted checkouts stay fast and correct.

A "checkout" is the hosted-checkout flow: `GET /v1/payment-links/:token`
then `POST /v1/payment-links/:token/pay` (Idempotency-Key, simulated card,
including the simulator's 100-400 ms acquirer latency and 2% acquirer errors).

## How it was measured

`ops/loadtest/checkout.mjs` against the API in a container with the judging
limits (`--cpus 0.5 --memory 512m`, `NODE_ENV=production`, pool of 5,
`LOAD_SHED_MAX_INFLIGHT=10`), Postgres outside the limit:

| Buyers | Checkouts/s | p50 | p95 | p99 | 503 shed | Errors | Duplicate payments |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10  | 8.2 | 1.21 s | 1.65 s | 1.82 s | 0     | 0 | 0 |
| 20  | 8.1 | 2.42 s | 3.15 s | 3.41 s | 0 (shedding at 40) | 1 acquirer error | 0 |
| 40  | 7.9 | 4.65 s | 5.71 s | 6.90 s | 0 (shedding at 40) | 7 acquirer errors | 0 |
| 150 | 7.6 | 1.20 s | 1.89 s | 2.20 s | 4111  | 3 acquirer errors | 0 |

Throughput is flat at ~8/s: the 0.5 vCPU is the bottleneck. Without shedding,
more buyers only add queueing (20 and 40 rows). With shedding at 10 in-flight
requests (150 row), throughput holds and latency of admitted checkouts stays
where it is at 10 buyers. Memory stayed ~100 MB of 512 MB throughout. The
production VM shares one vCPU with Postgres, so expect somewhat lower than the
local figures; 6-8 checkouts/s is the honest range.

## Past the limit

- **Turns away excess:** `plugins/loadShed.ts` rejects requests beyond
  `LOAD_SHED_MAX_INFLIGHT` (10 in production) with 503 + Retry-After. Health
  checks are never shed.
- **Restarts itself:** systemd (`ops/dilmune/setup.sh`) runs the API with
  `Restart=always`, `CPUQuota=50%`, `MemoryMax=512M`; a crash or OOM kill is
  restarted in ~2 s. `KillMode=control-group` also stops tsx's child process,
  which pm2 left orphaned on port 3000.
- **No data loss:** every payment step is a Postgres transaction; a link is
  reserved with a token before the acquirer call, and an interrupted attempt
  is released or refunded, never double-charged. Idempotency-Key makes client
  retries safe. The load test checks no link was paid twice.

## Reproduce

```bash
docker build -f ops/Dockerfile.node -t filspay-api-load .
docker run -d --name fp-load-api --cpus 0.5 --memory 512m -p 127.0.0.1:3300:3000 \
  -e NODE_ENV=production -e DATABASE_URL=... -e OTP_DEV_EXPOSE=true -e COOKIE_SECURE=false \
  -e LOAD_SHED_MAX_INFLIGHT=10 ...other required env... \
  filspay-api-load npx tsx apps/api/src/index.ts
DATABASE_URL=<same test db> node ops/loadtest/checkout.mjs --api http://127.0.0.1:3300 --users 150 --seconds 30
```
