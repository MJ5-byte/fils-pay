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

For Dilmun Cloud web deployments, use `npm ci` as the install command and
`npm run build` as the build command. The root build script builds
`@filspay/web`; set the output directory to `apps/web/dist`.

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

- The API allows browser requests from the local web and admin origins on
  ports 5173 and 5174. A different host or port must be explicitly added to
  the API's CORS allowlist.

`ops/Dockerfile.node` and `ops/Dockerfile.go` build the compose services, and
all migrations apply cleanly to an empty database.

## Development accounts

The seed creates local-only merchant and admin fixtures. All seeded merchant
users use `FilsPaySeed!2026`; seeded admins use `FilsPayAdminSeed!2026`.
Development login uses a one-time code returned by the API.

Merchant dashboard login requires the merchant ID, email, password, and OTP.
Find the fixture merchant ID in the `merchants` table. Admin login uses email,
password, and OTP. Never use these fixture credentials outside local
development.

### Log in to the local admin console

The following steps use the local PostgreSQL test container and seeded admin
accounts from this development environment. The database must already be
migrated and seeded; do not run the seed command against a database containing
data you need.

1. In PowerShell, start the local PostgreSQL container:

   ```powershell
   docker start filspay-test-pg-30220
   ```

2. In a separate PowerShell terminal from the repository root, start the API:

   ```powershell
   $env:DATABASE_URL = "postgres://filspay_test:filspay_test_local@127.0.0.1:55432/filspay_test?sslmode=disable"
   $env:WEBHOOK_SECRET_ENCRYPTION_KEY = [Convert]::ToBase64String([byte[]]::new(32))
   npm.cmd run dev --workspace @filspay/api
   ```

3. In another terminal from the repository root, start the admin frontend:

   ```powershell
   npm.cmd run dev --workspace @filspay/admin
   ```

4. Open [http://localhost:5174/login](http://localhost:5174/login) and sign in:

   - Email: `superadmin@filspay.test`
   - Password: `FilsPayAdminSeed!2026`

5. After selecting **Continue**, enter the development OTP displayed on the
   page.

The API and frontend must remain running in their terminals. These credentials
are for local development only. For a new database, run `npm run migrate` and
`npm run seed` first.

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

## Login Details

Use these local development accounts at
[http://localhost:5174/login](http://localhost:5174/login). The API must be
running at `http://localhost:3000`, and the local database must be migrated
and seeded.

| Email | Password | Role |
|---|---|---|
| `support@filspay.test` | `FilsPayAdminSeed!2026` | Support |
| `finance@filspay.test` | `FilsPayAdminSeed!2026` | Finance |
| `superadmin@filspay.test` | `FilsPayAdminSeed!2026` | Super admin |

After entering your email and password, select **Continue** and enter the
development OTP displayed on the page. These accounts are for local
development only.

## Investigation: adjustment CSV amount parsing

The admin adjustment CSV parser previously used `parseDecimalMinor` with its
two-decimal default. That interpreted `4.75` BHD as `475` fils rather than
`4,750` fils, and did not follow ADR-0001's requirement that BHD text amounts
use `parseBhdToFils`.

`parseAdjustmentAmountFils` now delegates to `parseBhdToFils`. Two- and
three-decimal BHD values are converted to integer fils consistently, signed
adjustments remain supported, and invalid input is still returned as the
existing `invalid_amount` API error.

## Capture Git history

From the repository root, capture the commit graph in `git-history.txt`:

```sh
git --no-pager log --graph > git-history.txt
```

The `>` redirection replaces the file's contents each time the command runs.