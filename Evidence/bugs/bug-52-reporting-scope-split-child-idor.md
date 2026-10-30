# Bug 52 — Reporting scope accepts any split-child merchant (IDOR)

**Severity:** High · **Area:** Reporting · **Clue:** Architecture — merchant-scoped queries take the merchant from the authenticated context

## Where
- `apps/api/src/reporting/scope.ts:12-19` — if `requestedMerchantId` exists in `merchant_split_children` it is accepted; no `parent_merchant_id = caller`

## What's wrong
Merchant A can request reports for child C that belongs to parent B, just by knowing C's id.

## Why
"Is this id a child of someone?" instead of "is this id **my** child?"

## What it breaks
Cross-tenant volume, payout, and capture data via the reporting API.

## Smallest fix
`WHERE child_merchant_id = $1 AND parent_merchant_id = $2`.
