import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const pool = new Pool({ connectionString: "postgres://unused/unused" });
const app = buildApp(
  loadConfig({
    DATABASE_URL: "postgres://unused/unused",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  }),
  pool,
);

after(async () => {
  await app.close();
  await pool.end();
});

for (const origin of ["http://localhost:5173", "http://localhost:5174"]) {
  test(`CORS allows credentialed requests from ${origin}`, async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: origin.endsWith("5173") ? "/v1/auth/login" : "/v1/admin/auth/login",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.equal(response.headers["access-control-allow-credentials"], "true");
  });
}

test("CORS does not allow an untrusted origin", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/auth/login",
    headers: {
      origin: "https://not-local.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});
