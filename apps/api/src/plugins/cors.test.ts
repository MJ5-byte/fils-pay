import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { corsPlugin } from "./cors.js";

const app = Fastify();
app.register(corsPlugin, {
  config: { corsAllowedOrigins: ["http://localhost:5173"] },
});
app.get("/ping", async () => ({ pong: true }));

test.after(async () => {
  await app.close();
});

test("CORS allows credentialed requests and preflight only for configured origins", async () => {
  const allowed = await app.inject({
    method: "GET",
    url: "/ping",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");

  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/ping",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(preflight.statusCode, 204);
  assert.ok(preflight.headers["access-control-allow-methods"]);

  const unknown = await app.inject({
    method: "GET",
    url: "/ping",
    headers: { origin: "http://evil.example" },
  });
  assert.equal(unknown.statusCode, 200);
  assert.equal(unknown.headers["access-control-allow-origin"], undefined);
});
