# Performance and load

Simple ≠ slow: complexity and I/O fixes always apply. Caches, queues and new infrastructure only when a
measurement shows they're needed. Anything adding infrastructure (Redis, a broker, a service) needs human approval.

## Per-PR checklist

**Time complexity**
- Know the Big-O of loops you write or touch. No nested loops over growing data when a map/set makes it O(n).
- Sort once, index once — not inside a loop.

**Redundant work and data structures**
- No DB query inside a loop (N+1): batch with `WHERE id IN (...)` or JOIN.
- Hoist repeated computation out of loops. Don't parse/serialize the same data twice.
- Membership → set/map, not a list scan. Preallocate when size is known. Build strings with a builder/join.
- Frontend: no duplicate fetches; independent requests in parallel; no heavy recomputation every render.

**Bottlenecks**
- DB: select only needed columns, paginate lists, no unbounded queries. Unindexed filter/join column → flag it
  (adding an index needs human approval).
- Memory: stream or paginate large results; never load a whole table.
- Do once (startup) what doesn't need doing per request. Timeouts on every external call. No leaked goroutines,
  connections or file handles.
- Micro-optimizations only for a measured bottleneck, and only if the code stays readable.
- Measure: Go `go test -bench . -benchmem` / `pprof`; Python `python -m cProfile`; browser DevTools.

## Handling many clients — climb only as far as measurements say

1. Fix the code (checklist above).
2. Bounded connection pools (Go `SetMaxOpenConns/SetMaxIdleConns/SetConnMaxLifetime`, Python ORM pool settings,
   Node one shared `Pool`). Reuse HTTP clients.
3. Timeouts everywhere; bounded concurrency for fan-out (worker pool/semaphore, never unbounded goroutines or
   `Promise.all` over user-sized lists).
4. Never block the request path: no blocking I/O in Python async code, no heavy CPU on Node's event loop,
   enough Python worker processes.
5. Cache read-heavy, rarely-changing data with a TTL. If we run several instances, keep any state that must be
   shared in the DB. Never cache balances.
6. Queue slow side effects, never money: transfers stay synchronous and transactional. Emails/notifications/reports →
   in-process bounded worker queue (lost on crash), or a jobs table in the **existing** DB claimed with
   `SELECT ... FOR UPDATE SKIP LOCKED` when jobs must not be lost.
7. Rate limiting only if measurements show abuse-driven overload — under a judges' stress test, `429`s may count as errors.
8. Correct under concurrency: two identical money requests at once must not double-spend
   (`UPDATE ... WHERE balance >= $1`, unique constraints). Test it with concurrent requests.

## Load test (Friday afternoon)

Run against the app running locally (Docker can't reach `localhost` on the host, use `host.docker.internal`).
Git Bash / macOS / Linux:
```bash
docker run --rm -i --add-host=host.docker.internal:host-gateway grafana/k6 run - < loadtest.js
```
PowerShell: `Get-Content loadtest.js | docker run --rm -i grafana/k6 run -`

- Watch p95 latency, error rate, DB connections, memory. Profile the bottleneck, fix, re-run.
- Local numbers don't show the hosted limits: run one short, gentle test against Dilmune too, after checking its limits.
- Record before/after numbers in `REPORT.md`.

Starter `loadtest.js`. The thresholds make k6 exit non-zero when they fail, so a run is a pass or a fail, not a
number to eyeball. Swap `/health` for the real flows (login, list, transfer) once recon knows them, and pass the
target with `-e BASE_URL=...` on the `docker run` line.
```js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 20,
  duration: '1m',
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8080';

export default function () {
  check(http.get(`${BASE}/health`), { 'status is 200': (r) => r.status === 200 });
}
```

## Monitoring and Grafana

- **The repo ships a monitoring stack** (Grafana, Prometheus, Loki, a `/metrics` route): bring it up with the app on
  Thursday. Read every dashboard, alert rule, annotation and saved log query. They show what the last developer
  watched and when things changed, so log what stands out as a `Clue`.
- **It ships none:** no new infrastructure without human approval (rule above). If a metrics library is already a
  dependency, exposing its standard endpoint is the cheap win; otherwise skip it.
- **Load test with the dashboards open.** Capture p95 latency, error rate and DB connections before and after each
  performance fix. Those pairs go in `REPORT.md` and the Saturday walkthrough (CLAUDE.md section 12).
- **Health:** the deploy smoke test needs one route per service that also checks its database. Add it only where
  none exists.
