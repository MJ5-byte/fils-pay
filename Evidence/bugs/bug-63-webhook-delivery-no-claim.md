# Bug 63 — Due webhooks are not claimed, and disabling an endpoint does not stop them

**Severity:** Medium · **Area:** Webhooks · **Source:** CODE-029

## Where
- `apps/api/src/webhooks/dispatcher.ts:217-227` — Step B selects `status = 'pending'` with no `FOR UPDATE SKIP LOCKED`
- The same query joins `webhook_endpoints` for the URL and does not require `we.status = 'active'`
- `apps/api/src/index.ts` comment says replicas are safe because of `SKIP LOCKED`. That clause is not in this query. Step A (creating rows) does filter `we.status = 'active'`.

## What's wrong
Two API processes can both read the same pending row and both POST it. A pending delivery created while the endpoint was active is still sent after the endpoint is disabled, and it is sent to whatever URL is on the row now, including one edited after the event.

## Why
The "one replica" comment and the "SKIP LOCKED" comment describe different designs. Neither matches a second replica, which staging comments say has been running.

## What it breaks
Merchants receive the same event twice. A disabled or retargeted endpoint still gets traffic, which also widens Bug 43 (SSRF) after the URL is changed.

## Smallest fix
Claim the row (`UPDATE … WHERE status = 'pending' … RETURNING`, or `FOR UPDATE SKIP LOCKED` plus a status flip) before the HTTP call. Join `we.status = 'active'` in the due query, and snapshot the URL onto the delivery row when it is created.
