---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/package.json"
  - "**/tsconfig*.json"
---

# TypeScript rules

Sources: TypeScript handbook (strict mode), typescript-eslint strict-type-checked, Google TypeScript Style Guide.
Repo conventions win where they conflict — except type safety, error handling, security and money rules.

## Tooling (must pass on every change)
- `npx tsc --noEmit` (or the repo's typecheck script): zero new errors.
- Repo lint, test and build scripts from `package.json`. Use the repo's package manager (check the lockfile).
- Do NOT tighten `tsconfig`/eslint config repo-wide — it would flood the PR with unrelated errors.
  Instead, write all new/changed code as if `strict`, `noUncheckedIndexedAccess` and
  `strictTypeChecked` were on.

## Types
- No `any`. Use `unknown` and narrow. No `as` casts except right after runtime validation.
- No non-null assertion `!`. Handle the `undefined` case.
- No `@ts-ignore`. If unavoidable: `@ts-expect-error <reason>`.
- Validate all external data at the boundary (HTTP responses, request bodies, forms, localStorage)
  with the repo's validator (zod etc.) or a type guard. Don't trust `res.json() as Foo`.
- Model state with discriminated unions (`{ status: "loading" } | { status: "error"; error: string } | ...`),
  and make `switch` exhaustive with a `never` check.
- Prefer `type`/`interface` per repo convention; `readonly` for data that shouldn't change.

## Async and errors
- No floating promises: every promise is `await`ed, returned, or explicitly handled with `.catch`.
- Never an empty `catch {}`. Catch only where you can handle or add context; otherwise let it propagate.
- `catch (err)` — `err` is `unknown`; narrow before use.
- Show the user a meaningful error state; never fail silently in the UI.
- Use `Promise.all` for independent requests, not sequential awaits.

## Style
- `const` by default, `let` only when reassigned, never `var`. `===` always.
- Small, focused functions and components. Early returns.
- camelCase vars/functions, PascalCase types/components, UPPER_SNAKE for true constants.
- No magic strings for API routes/statuses scattered around — one definition, reused.
- No `console.log` in committed code (use the repo's logger if any).
## Security
- Never put secrets in frontend code or public env vars (`NEXT_PUBLIC_*`, `VITE_*` are shipped to the browser).
- No `innerHTML` / `dangerouslySetInnerHTML` with user or API data.
- Authorization is enforced on the server; the UI hiding a button is not security.

## If React
- Follow the rules of hooks; complete effect dependency arrays (don't silence the lint).
- Don't copy props into state; derive during render.
- Stable `key`s from IDs, never array index for dynamic lists.
- Effects are for syncing with external systems, not for computing values.

## Money
- Never do arithmetic on money as JS `number` decimals (`0.1 + 0.2`). Use integer minor units
  (or `bigint`) or the repo's decimal library. Format for display only, with `Intl.NumberFormat`
  (`currency: "BHD"` has 3 decimals).

## Tests
- Use the repo's runner (vitest/jest/playwright). Test behavior, not implementation details.
- One test that would fail without your change, for every fix and feature.
