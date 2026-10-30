# Runbook

Short on purpose. If something here is wrong or missing, fix it after the
incident, not during.

## Health

- `GET /healthz` — the process answers. That's all it tells you.
- `GET /readyz` — the API reached Postgres when it booted. It does not
  re-check afterwards; a green `/readyz` says nothing about the database
  right now. To check the database, run a query.

> **FH:** the FP-215 PR description says readyz re-checks every 30s now. not sure it merged
>
> **— unsigned:** it pings on every request since FP-215. this section is stale

## The API container keeps restarting / requests die with no error

No stack trace in the app logs usually means the kernel killed it, not
Node. The API container is capped at 512 MB.

```bash
dmesg -T | grep -i -E "killed process|out of memory"
docker inspect <container> --format '{{.State.OOMKilled}}'
```

If it's OOM, find the request that was in flight when it died (the access
log line that never got a response) before raising the limit.

The most common cause so far has been sharp's in-process image cache when
support pages through KYC thumbnails. Set `SHARP_CACHE=0` on the API
container and restart.

## Settlement didn't run for a day

The daemon only catches up the most recent business day on restart. For
anything older:

```bash
settlement run-batch --date=YYYY-MM-DD            # every merchant
settlement run-batch --date=YYYY-MM-DD --merchant=<uuid>
```

`--date` is the Bahrain business date. Safe to repeat: a batch that's
already closed or paid is left alone.

> **— unsigned:** re-running a date from before a merchant went live can settle their test captures. check go-live dates first

## A merchant's balance looks wrong

`merchant_balances` is a cache. Recompute it:

```bash
settlement rebuild-balances                       # prints before/after per merchant
settlement rebuild-balances --merchant=<uuid>
```

If you don't have shell access, the console's **Rebuild cached balances**
does the same for all merchants. If the rebuilt figure is still wrong, use
**Adjust balance** for the remaining difference and note the ticket in the
reason.

## After deploying migration 0080 (refund columns)

The reporting watermark already passed every `refund.succeeded` event made before the deploy,
so those refunds are not in `merchant_daily_volume`. Run the rebuild once after migrating:

```bash
reporting rebuild
```

It truncates the two rollup tables and replays the outbox, so it also fills `refund_count` and
`refund_gross_fils` for older refunds. Dashboard daily volume is briefly empty while it runs.

## Dashboards look stale

Analytics lag the write model by up to a poll interval; every response
carries `readModelAsOf`. If it's stuck:

```bash
npx tsx apps/reporting/src/index.ts catch-up
```

`catch-up` shares the worker's cursor, so it's safe to run while the worker
is up. Then check the reporting worker is running and connected.

If `readModelAsOf` is `null` after a fresh seed, restart the worker; it
usually needs a couple of restarts while Postgres warms up.

> **MK:** stop the worker before catch-up. two consumers on one cursor double-apply.

## Webhooks aren't arriving

1. Look at the endpoint's delivery log (dashboard, or
   `GET .../webhook-endpoints/:id/deliveries`). `failed` means we got a non-2xx
   and will retry; `exhausted` means retries are done.
2. Check the merchant's endpoint URL and that their receiver returns 2xx
   within the timeout.
3. If **no** merchant is receiving anything, restart the API — the
   dispatcher's `LISTEN` connection occasionally drops (FP-236).
4. Replay from the dashboard, or in bulk from the admin console.

> **FH:** last stall had a TypeError from buildEnvelope in the logs and came back after restart on the same event
>
> **— M?** bad deploy, rolled back

If a merchant reports that signatures don't verify, ask them to compute the
HMAC over the raw request body exactly as received, before any JSON parsing;
the body we send is the exact string we sign (BHA-15).

> **MK:** if signatures don't verify over the raw body, that's on us. FP-240

## Scheme file for a batch

```bash
settlement export-scheme-file --batch=<uuid> --out=/tmp/batch.csv
```

Re-exporting gives an identical file; it's written from rows frozen at
close. The `amount` column is in the scheme's two-decimal format and is
what the scheme was paid; finance reconciles against it.

## Month-end residue (finance)

Residue posting is automated: since BHA-19 (PR #111) CloseBatch journals
each scheme export line's rounding residue at close, as ADR-0002 says, so
there is no month-end script to copy or edit. `scripts/reconcile_march.ts`
is only for batches closed before that, in March 2026:

1. Run it once against production with finance on the call:
   `DATABASE_URL=... npx tsx scripts/reconcile_march.ts`.
2. Attach its output to the month-end ticket.

It picks the batches whose `batch_date` falls in March. `batch_date` is the
Asia/Bahrain business day CloseBatch closes (`BusinessDayWindow`), so this is
the Bahrain business month. It posts one balanced group per export line and
skips any batch that already carries residue legs, from CloseBatch or from an
earlier run, so a second run posts nothing. It posts nothing and exits with
an error if any line's residue is outside 0 to 9 fils, or if the old version
of the script left `merchant_payable` legs that have not been reversed.

The old-script check nets those `merchant_payable` legs to zero only when
finance's reversal carries the same description string as the old run
("March 2026 scheme rounding residue sweep — manual recon per finance"); a
reversal with any other description keeps the sweep blocked.

> **Huda** (#fp-finance): please don't run anything for April onwards until March (FP-187) is resolved

## Resetting a non-production environment

```bash
npm run migrate && npm run seed
```

The seed truncates and regenerates the fixture tables it owns and
self-checks the result. It prints `REAL FAIL` lines if anything doesn't
come out as expected — don't ignore them. It won't touch other tables, so
it's safe against a shared staging database.

> **AM (Sept):** check DATABASE_URL before seeding. staging-2 got reset this way
