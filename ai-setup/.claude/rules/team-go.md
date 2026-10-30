---
paths:
  - "**/*.go"
  - "**/go.mod"
---

# Go rules

Sources: Effective Go, Go Code Review Comments, Google Go Style Guide, Uber Go Style Guide.
Repo conventions win where they conflict — except error handling, concurrency safety, SQL and money rules.

## Tooling (must pass on every change)
- `gofmt -l <touched files>` empty. Run `gofmt -w`/`goimports -w` only on files you touch — first check
  the file was already gofmt'd, otherwise format only your own lines to avoid diff noise.
- `go vet ./...` and `go build ./...` clean.
- `go test ./<touched pkgs>/...` while working. `-race` for money/concurrency packages before merge —
  it needs cgo (a C compiler); on Windows without gcc run it in WSL or Docker, and note it in the PR if skipped.
- If installed: `golangci-lint run --new-from-rev=origin/main` (only issues in new code), else `staticcheck ./...`.

## Errors
- Never ignore an error. `_ = f()` on an error-returning call needs a comment saying why it is safe.
- Wrap with context: `fmt.Errorf("load account %s: %w", id, err)`. Lowercase, no trailing punctuation.
- Compare with `errors.Is` / `errors.As`, never by string.
- Handle an error once: either log it or return it, not both.
- Indent the error path, keep the happy path at the left margin; return early.
- No `panic` in request handling or library code. `panic` only for truly impossible programmer errors at startup.

## Context, I/O and resources
- `ctx context.Context` is the first parameter of anything that does I/O; pass it through, never store it in a struct.
- Never use `context.Background()` inside a request path — use the request's context.
- HTTP clients and servers must have timeouts (no bare `http.Get`, no zero-timeout `http.Server`).
- `defer resp.Body.Close()` / `rows.Close()` right after the error check. Check `rows.Err()` after iterating.
- Database: parameterized queries only (`$1`/`?`), use transactions for multi-statement writes, `defer tx.Rollback()`.

## Concurrency
- Every goroutine has a known exit (ctx cancellation, closed channel, or WaitGroup). No fire-and-forget.
- Shared mutable state is guarded by a mutex or owned by one goroutine. Never copy a `sync.Mutex` (pass pointers).
- The sender closes a channel, never the receiver.
- Prefer `errgroup` (if already a dependency) over hand-rolled WaitGroup + error channels.

## Design
- Accept interfaces, return concrete types. Define interfaces where they are consumed; keep them small.
- No package-level mutable state; no side effects in `init()`.
- No `util`/`common`/`helpers` packages. Name packages for what they provide.
- Zero values should be useful; avoid constructors that only set defaults.

## Naming
- MixedCaps; initialisms stay uppercase: `userID`, `HTTPClient`, `parseURL`.
- No stutter: `account.New`, not `account.NewAccount`; `wallet.Service`, not `wallet.WalletService`.
- Short consistent receiver names (`s *Service`), never `this`/`self`.
- Exported identifiers have doc comments starting with the name.

## Money
- Never `float32`/`float64` for amounts. Use `int64` minor units or the repo's decimal type.
- Check for overflow on arithmetic with untrusted amounts.

## Tests
- Table-driven with `t.Run(tc.name, ...)`. Use `t.Helper()` in helpers.
- `httptest` for handlers. No sleeps for synchronization.
