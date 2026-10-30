# Bug 70 — The migration runner records the filename only

**Severity:** Low · **Area:** Database · **Source:** CODE-012, CODE-038

## Where
- `db/migrate.ts:71-77` — `schema_migrations` is `(filename, applied_at)`
- Lines 67-69 say the table also stores a checksum and refuses to run if an applied file changed. It does not.
- `listMigrationFiles` sorts names and applies each file in its own transaction. There is no advisory lock.

## What's wrong
Editing an already-applied `.sql` file, including a comment, does not change what a database that already passed that filename will do. Two migrators starting together can both decide a file is pending. Gaps in the numbers (0039, 0041, 0059, 0062, 0063, 0067) are harmless; the runner does not require a continuous sequence. The failure on a fresh database is Bug 57, not the gaps.

## Why
The checksum was written into the comment when the table was created without that column.

## What it breaks
A "fixed" migration that is edited in place never reaches databases that already applied the old text. Overlapping migrate jobs can both try the same file.

## Smallest fix
Store `sha256` of the file body and fail when it disagrees with the applied row. Take `pg_advisory_lock` for the duration of `main`.
