/**
 * Route-level checks for the CORS plugin — the one behaviour in the API that
 * cannot be exercised by same-origin unit tests: a browser on the dashboard
 * port calls this API cross-origin with credentials, and without CORS headers
 * every such request is blocked at runtime.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("cors.test.ts requires DATABASE_URL (run `npm run migrate` first)");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("a preflight OPTIONS from an allowed origin answers 204 with CORS headers", async () => {
  const res = await app.inject({
    method: "OPTIONS",
    url: "/v1/auth/login",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.match(res.headers["access-control-allow-headers"] ?? "", /idempotency-key/i);
});

test("a simple request from an allowed origin carries the CORS headers", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "http://localhost:5174" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5174");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});

test("a disallowed origin gets no CORS headers", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "http://evil.example" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});
