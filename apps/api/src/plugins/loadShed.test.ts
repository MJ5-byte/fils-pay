import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerLoadShed } from "./loadShed.js";

function slowApp(maxInFlight: number) {
  const app = Fastify();
  registerLoadShed(app, { maxInFlight });
  let releaseAll!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  app.get("/slow", async () => {
    await gate;
    return { ok: true };
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  return { app, releaseAll };
}

test("requests beyond maxInFlight get 503 with Retry-After; admitted ones still succeed", async () => {
  const { app, releaseAll } = slowApp(2);
  const admitted = [app.inject({ url: "/slow" }), app.inject({ url: "/slow" })];
  await new Promise((r) => setImmediate(r));

  const shed = await app.inject({ url: "/slow" });
  assert.equal(shed.statusCode, 503);
  assert.equal(shed.headers["retry-after"], "1");
  assert.equal(shed.json().error, "overloaded");

  releaseAll();
  for (const res of await Promise.all(admitted)) assert.equal(res.statusCode, 200);

  // Slots are released once responses finish, so new requests are admitted again.
  const after = await app.inject({ url: "/slow" });
  assert.equal(after.statusCode, 200);
  await app.close();
});

test("health checks are never shed, even when saturated", async () => {
  const { app, releaseAll } = slowApp(1);
  const busy = app.inject({ url: "/slow" });
  await new Promise((r) => setImmediate(r));

  const health = await app.inject({ url: "/healthz" });
  assert.equal(health.statusCode, 200);

  releaseAll();
  await busy;
  await app.close();
});

test("maxInFlight 0 disables shedding", async () => {
  const { app, releaseAll } = slowApp(0);
  const many = Array.from({ length: 20 }, () => app.inject({ url: "/slow" }));
  await new Promise((r) => setImmediate(r));
  releaseAll();
  for (const res of await Promise.all(many)) assert.equal(res.statusCode, 200);
  await app.close();
});
