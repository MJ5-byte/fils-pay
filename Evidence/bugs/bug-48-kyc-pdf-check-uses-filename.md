# Bug 48 — KYC "must be a PDF" checks the filename, not magic bytes

**Severity:** Medium · **Area:** Onboarding · **Clue:** Architecture — *"KYC uploads are validated by detected content type (magic bytes)."*

## Where
- `apps/api/src/onboarding/kyc.ts:50-68` — PDF-only document types require a `.pdf` suffix on `fileName`; a JPEG named `x.pdf` passes

## What's wrong
Content-type detection exists but the PDF rule does not use it. Architecture's magic-byte claim is false for the constraint that matters.

## Why
Filename extension was cheaper than looking at `detected`.

## What it breaks
Non-PDF KYC documents enter the queue labelled as PDFs. Reviewers approve garbage. Combined with Bug 49, they can be bulk-approved.

## Smallest fix
For PDF-only types, require `detected === 'pdf'` (and keep the extension check if you want).
