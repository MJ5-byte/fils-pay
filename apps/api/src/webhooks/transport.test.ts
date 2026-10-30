/**
 * The real transport against a local loopback receiver, no database needed.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createFetchTransport } from "./transport.js";

test("a receiver that streams past the cap and never ends still resolves with its status and a capped body", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const receiver = http.createServer((_req, res) => {
    res.writeHead(200);
    const chunk = "x".repeat(16 * 1024);
    const pump = setInterval(() => res.write(chunk), 1);
    res.on("close", () => clearInterval(pump));
  });
  receiver.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const address = receiver.address();
    assert.ok(address && typeof address !== "string");
    const started = Date.now();
    const response = await createFetchTransport({ webhookAllowPrivateTargets: true })({
      url: `http://127.0.0.1:${address.port}/`,
      headers: {},
      body: "{}",
      timeoutMs: 5000,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.length > 0 && response.body.length <= 64 * 1024, `body length ${response.body.length}`);
    assert.ok(Date.now() - started < 1000, "resolved long before the timeout");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});
