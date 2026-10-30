# Bug 33 — Seed truncates the entire database

**Severity:** High · **Area:** Ops · **Clue:** HANDOVER / onboarding; running `docker compose` against a shared DB

## Where
- `db/seed/generate.ts:110-138, 210-212` — `TRUNCATE merchants, transactions, ledger_entries, … RESTART IDENTITY CASCADE` while a comment claims it is safe on shared/staging

## What's wrong
The seed is not an upsert. It wipes merchants, ledger, batches, admin users, sessions. Running it against anything other than an empty local DB is destructive.

## Why
Fixture generator was written as "reset then fill" and the comment was never made true.

## What it breaks
Accidental wipe of staging (or worse). Combined with Bug 57, recovering a fresh environment is already hard.

## Smallest fix
Refuse to run unless `ALLOW_DESTRUCTIVE_SEED=1` and the database name matches a local/dev allowlist.
