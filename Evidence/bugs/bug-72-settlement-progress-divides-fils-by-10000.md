# Bug 72 — Settlement batch progress divides fils by 10 000 and treats that as a percentage

**Severity:** Low · **Area:** UI · **Source:** source review of `apps/web` (the money investigations did not cover this page line by line)

## Where
- `apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx:84-91`

```ts
const displayProgress = parseFloat((batch.grossFils / 10000).toFixed(2));
// ...
width: `${Math.min(displayProgress, 100)}%`
```

1 BD = 1000 fils (ADR-0001). The bar is only rendered when `batch.status === "closed"`.

## What's wrong
`grossFils / 10000` is ten times too small for a BD amount, and the result is then used as a width percentage. A batch of 500 000 fils (500 BD) draws a 50% bar. A batch of 1 000 000 fils or more draws 100%. `parseFloat` does not change that. The amounts in the definition list on the same page go through `formatBhd` and are not affected.

## Why
A progress calculation was pointed at the gross amount with a cents-sized divisor.

## What it breaks
The closed-batch page shows a bar that is not a progress measure. It saturates for any batch over 1 000 BD.

## Smallest fix
Remove the bar, or bind it to a real ratio (for example paid vs closed) computed in integer fils. Do not divide by 10 000.
