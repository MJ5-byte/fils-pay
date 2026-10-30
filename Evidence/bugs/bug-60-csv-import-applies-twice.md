# Bug 60 — The same adjustment CSV can be imported twice

**Severity:** High · **Area:** Money / admin · **Source:** CODE-010, EVID-014 (two identical uploads both committed)

## Where
- `apps/api/src/admin/adjustmentImport.ts:56-64` — inserts a new `adjustment_imports` row every time
- Comment on line 64 says a unique `original_filename` blocks a re-upload. No such unique index exists.

## What's wrong
Each `POST /v1/admin/adjustment-imports` parses the file and posts a ledger group per row. Uploading the same filename and the same rows a second time creates a second import id and posts the amounts again. EVID-014 did this: two uploads of `4.750` produced two payable credits (950 fils total, already scaled by Bug 19).

## Why
Idempotency was described in a comment and never added to the schema.

## What it breaks
A double-click or a finance retry doubles every manual adjustment. Combined with Bug 19 the posted total is both wrong and repeated.

## Smallest fix
Hash the file (or the parsed rows) and reject a hash already stored. Do not rely on the filename.
