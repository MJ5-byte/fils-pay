import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

// Client-side request errors are rejected by Fastify before any route handler
// runs, so they never touch the database. A syntactically valid but unreachable
// DATABASE_URL is enough for this file.
const config = loadConfig({
  DATABASE_URL: "postgres://unused/unused",
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function assertNoLeakedInternals(body: string): void {
  assert.equal(body.includes("internal_error"), false, "client errors must not return internal_error");
  assert.equal(/\bat \//.test(body), false, "response must not leak a stack trace");
  assert.equal(body.toLowerCase().includes("select "), false, "response must not leak SQL");
}

test("a malformed JSON body returns 400, not 500, with no leaked internals", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: "{ this is not valid json",
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "bad_request");
  assertNoLeakedInternals(res.body);
});

test("an unsupported content type returns 415, not 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { "content-type": "application/xml" },
    payload: "<login/>",
  });
  assert.equal(res.statusCode, 415, res.body);
  assert.equal(res.json().error, "unsupported_media_type");
  assertNoLeakedInternals(res.body);
});
