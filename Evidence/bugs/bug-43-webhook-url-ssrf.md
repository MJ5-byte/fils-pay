# Bug 43 — Webhook URLs are not blocked from hitting internal networks (SSRF)

**Severity:** High · **Area:** Security · **Clue:** Architecture webhook delivery; compose internal settlement HTTP API

## Where
- `apps/api/src/webhooks/create.ts:15-28` — no private-IP check
- `apps/api/src/webhooks/transport.ts:38-48` — `fetch` with default `redirect: "follow"`
- `apps/api/src/webhooks/testSend.ts` — echoes up to 2KB of the response back to the merchant

## What's wrong
A merchant (or anyone who can create an endpoint) can set `url` to `http://settlement:8091/…`, `http://169.254.169.254/`, etc. Redirects follow. Test-send returns the body, so it is a browser for the API container.

## Why
No allowlist / deny-private resolver.

## What it breaks
SSRF from the API to settlement's internal token endpoint, metadata services, and anything else on the compose network.

## Smallest fix
Resolve the URL, deny RFC1918 / link-local / metadata IPs, `redirect: "manual"`. Do not echo response bodies from non-public hosts.
