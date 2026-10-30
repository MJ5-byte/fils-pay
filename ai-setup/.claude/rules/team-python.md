---
paths:
  - "**/*.py"
  - "**/pyproject.toml"
  - "**/requirements*.txt"
---

# Python rules

Sources: PEP 8, PEP 20, PEP 484, Google Python Style Guide, Ruff and mypy docs.
Repo conventions win where they conflict — except error handling, security, SQL and money rules.

## Tooling (must pass on every change)
- Use the repo's formatter/linter config if one exists (`pyproject.toml`, `ruff.toml`, `setup.cfg`).
- Otherwise: `ruff check <touched files>` only. Run a formatter only if the repo already configures one —
  `ruff format` on an unformatted file rewrites the whole file and buries the real change.
- Type checker (mypy/pyright) if the repo configures one: zero new errors.
- `pytest` for affected modules.
- Check the repo's Python version before using newer syntax.

## Types
- Type hints on every new or changed function signature (params and return).
- Modern syntax when the Python version allows: `list[str]`, `dict[str, int]`, `X | None`.
- No `Any` unless at a genuinely untyped boundary; narrow it immediately.
- Structured data uses the repo's convention (dataclass / pydantic / TypedDict), not loose dicts passed around.

## Errors
- Never bare `except:`; never `except Exception: pass`. Catch the specific exception you can handle.
- Re-raise with context: `raise PaymentError("transfer failed") from err`.
- Don't use exceptions for normal control flow.
- Validate at the boundary (request parsing), trust inside.

## Correctness traps
- No mutable default arguments (`def f(items=[])`) — use `None` and create inside.
- Files, connections, locks: always `with` context managers.
- `is` only for `None`/`True`/`False`/sentinels; `==` for values.
- In `async def`: never call blocking I/O (`requests`, `time.sleep`, sync DB drivers). Use the async equivalent.
- Timezone-aware datetimes only (`datetime.now(timezone.utc)`), never naive `datetime.now()`.

## Security
- Parameterized SQL only (driver placeholders / ORM). Never f-strings or `%` into SQL.
- No `eval`/`exec`, no `pickle`/`yaml.load` on untrusted data (`yaml.safe_load`), no `subprocess(..., shell=True)` with input.
- Secrets from env/config, never hardcoded.

## Style
- `logging` with lazy args: `log.info("transfer %s", tx_id)` — no `print` in committed code, no f-strings in log calls.
- f-strings for all other formatting.
- `pathlib` over `os.path` in new code.
- Imports at top, grouped stdlib / third-party / local; no `from x import *`.
- snake_case functions/vars, PascalCase classes, UPPER_SNAKE constants.
- Functions small and single-purpose; early returns.

## Money
- `decimal.Decimal`, constructed from strings or ints: `Decimal("10.50")`, never `Decimal(10.5)`.
- Explicit quantize + rounding mode: `amount.quantize(Decimal("0.001"), rounding=ROUND_HALF_EVEN)`
  (BHD has 3 decimal places — confirm the repo's convention).

## Tests
- pytest, plain `assert`, one behavior per test, arrange-act-assert.
- Use fixtures the repo already has; `tmp_path` for files; mock only external I/O.
