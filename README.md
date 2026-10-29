# FilsPay

FilsPay is a payment platform prototype for merchant checkout, operations,
settlement, and reporting. Its services share a PostgreSQL database and
communicate through a transactional outbox.

## Repository

| Path | Purpose |
|---|---|
| `apps/api` | Fastify API for merchant, checkout, and admin operations |
| `apps/web` | Merchant dashboard and checkout frontend (Vite/React) |
| `apps/admin` | Internal operations console (Vite/React) |
| `apps/settlement` | Go settlement worker and CLI |
| `apps/reporting` | Reporting read model and outbox consumer |
| `packages/money` | Shared integer-fils money helpers |
| `packages/events` | Outbox event types and database helper |
| `db/migrations` | PostgreSQL schema migrations |
| `db/seed` | Local development fixtures |
| `docs/` | Architecture, operations, onboarding, and decision records |

For the design and service responsibilities, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Operational setup notes are in
[`ops/README.md`](ops/README.md).

## Prerequisites

- Node.js and npm
- Go 1.22 or later for settlement
- PostgreSQL 16 for local development and database-backed tests
- Docker Desktop is optional, but useful for running PostgreSQL locally

## Install

From the repository root:

```sh
npm ci
```

## Local development

The web and admin frontends run as separate Vite dev servers. Start each in
its own terminal:

```sh
npm run dev --workspace @filspay/web
npm run dev --workspace @filspay/admin
```

By default, the merchant dashboard is at `http://localhost:5173` and the admin
console is at `http://localhost:5174`. Both expect the API at
`http://localhost:3000`.

The API requires `DATABASE_URL` to point to a migrated PostgreSQL database.
Start it with:

```sh
DATABASE_URL="postgres://USER:PASSWORD@localhost:5432/filspay" npm run dev --workspace @filspay/api
```

PowerShell equivalent:

```powershell
$env:DATABASE_URL = "postgres://USER:PASSWORD@localhost:5432/filspay"
npm.cmd run dev --workspace @filspay/api
```

Apply migrations and load development fixtures with:

```sh
npm run migrate
npm run seed
```

Both commands use `DATABASE_URL`. The seed resets and regenerates its fixture
data, so use it only with a development database.

### Current setup caveats

- `ops/docker-compose.yml` references `ops/Dockerfile.node` and
  `ops/Dockerfile.go`, which are not present in this checkout.
- A fresh database migration currently fails: migration `0054_views.sql`
  references the missing `settlement_batch_events` relation, and
  `0055_chart_of_accounts_suspense.sql` expects chart columns that are not in
  the schema created by migration `0007_ledger_double_entry.sql`.
- The frontends call the API directly from a different origin. The API does
  not currently configure CORS, so browsers may block frontend API requests
  even when the API is running.

These issues need to be resolved before a clean, full-stack local setup works
from scratch.

## Development accounts

The seed creates local-only merchant and admin fixtures. All seeded merchant
users use `FilsPaySeed!2026`; seeded admins use `FilsPayAdminSeed!2026`.
Development login uses a one-time code returned by the API.

Merchant dashboard login requires the merchant ID, email, password, and OTP.
Find the fixture merchant ID in the `merchants` table. Admin login uses email,
password, and OTP. Never use these fixture credentials outside local
development.

## Tests and checks

```sh
npm test
npm run typecheck
```

Database-backed TypeScript tests require `DATABASE_URL` to point to a migrated
test database. On Windows, run the Go tests in short mode:

```sh
cd apps/settlement
go test -short ./...
```

## Money and settlement conventions

- Monetary values are integer fils: 1 BHD = 1,000 fils.
- Parse text amounts with `parseBhdToFils` from `packages/money`.
- Settlement business-day boundaries use Asia/Bahrain time.
- Do not modify `packages/money` or `apps/settlement/internal/money` without
  finance approval; those packages are frozen after audit.
