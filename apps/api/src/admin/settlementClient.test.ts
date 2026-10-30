/**
 * Tests for the real `fetch`-based settlement client. No DB needed.
 *
 * The far side is a real `node:http` server on an ephemeral port standing in
 * for apps/settlement's Go internal server, so the HTTP layer itself is
 * genuinely exercised — the bearer header, the JSON body, the timeout, the
 * status-code mapping. What it cannot cover is whether the Go handler's own
 * JSON key casing matches: Go's `encoding/json` emits exported field names
 * verbatim unless `json:"..."` tags say otherwise, so the client is written
 * to accept both spellings and both are asserted here. Cross-service
 * integration against the real Go binary belongs to a later verification
 * pass.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { AppError } from "../lib/errors.js";
import {
  triggerBalanceRebuild,
  triggerSettlementRunBatch,
  type SettlementInternalConfig,
} from "./settlementClient.js";

interface FakeSettlement {
  url: string;
  requests: Array<{ method: string; path: string; authorization?: string; body: string }>;
  close: () => Promise<void>;
}

async function startFakeSettlement(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<FakeSettlement> {
  const requests: FakeSettlement["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("startFakeSettlement: could not determine listening port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function configFor(url: string, timeoutMs = 5_000): SettlementInternalConfig {
  return {
    settlementInternalUrl: url,
    settlementInternalToken: "test-settlement-token",
    settlementInternalRequestTimeoutMs: timeoutMs,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("triggerSettlementRunBatch posts the bearer token and body, and decodes Go's default PascalCase JSON", async () => {
  const fake = await startFakeSettlement((_req, res) => {
    // Exactly what `encoding/json` produces for settlement.DailyBatchReport
    // with no struct tags.
    sendJson(res, 200, {
      BusinessDate: "2026-09-09T00:00:00Z",
      MerchantResults: [
        {
          MerchantID: "11111111-1111-1111-1111-111111111111",
          BatchID: "22222222-2222-2222-2222-222222222222",
          AlreadyClosed: false,
          AlreadyPaid: true,
          GrossFils: 12_500,
          FeeFils: 312,
          NetPayoutFils: 12_188,
        },
      ],
    });
  });
  try {
    const summary = await triggerSettlementRunBatch(configFor(fake.url), {
      date: "2026-09-09",
      merchantId: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.method, "POST");
    assert.equal(fake.requests[0]!.path, "/internal/run-batch");
    assert.equal(fake.requests[0]!.authorization, "Bearer test-settlement-token");
    assert.deepEqual(JSON.parse(fake.requests[0]!.body), {
      date: "2026-09-09",
      merchantId: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(summary.businessDate, "2026-09-09T00:00:00Z");
    assert.equal(summary.merchantResults.length, 1);
    assert.deepEqual(summary.merchantResults[0], {
      merchantId: "11111111-1111-1111-1111-111111111111",
      batchId: "22222222-2222-2222-2222-222222222222",
      alreadyClosed: false,
      alreadyPaid: true,
      grossFils: 12_500,
      feeFils: 312,
      netPayoutFils: 12_188,
    });
  } finally {
    await fake.close();
  }
});

test("triggerSettlementRunBatch also decodes json-tagged camelCase, and omits merchantId when not given", async () => {
  const fake = await startFakeSettlement((_req, res) => {
    sendJson(res, 200, {
      businessDate: "2026-09-09T00:00:00Z",
      merchantResults: [
        {
          merchantId: "33333333-3333-3333-3333-333333333333",
          batchId: "44444444-4444-4444-4444-444444444444",
          alreadyClosed: true,
          alreadyPaid: false,
          grossFils: 1,
          feeFils: 0,
          netPayoutFils: 1,
        },
      ],
    });
  });
  try {
    const summary = await triggerSettlementRunBatch(configFor(fake.url), { date: "2026-09-09" });
    assert.deepEqual(JSON.parse(fake.requests[0]!.body), { date: "2026-09-09" });
    assert.equal(summary.merchantResults[0]!.merchantId, "33333333-3333-3333-3333-333333333333");
    assert.equal(summary.merchantResults[0]!.alreadyClosed, true);
  } finally {
    await fake.close();
  }
});

test("an unreachable settlement service is a 502 settlement_unreachable, never a 500", async () => {
  // A port nothing is listening on: connection refused, the exact failure a
  // stopped/not-yet-deployed settlement container produces.
  const err = await triggerSettlementRunBatch(configFor("http://127.0.0.1:1"), {
    date: "2026-09-09",
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
  assert.equal(err.statusCode, 502);
  assert.equal(err.code, "settlement_unreachable");
});

test("a timeout is also settlement_unreachable — nothing completed, so it is not a run failure", async () => {
  // Never responds; the AbortController must fire.
  const fake = await startFakeSettlement(() => {});
  try {
    const err = await triggerBalanceRebuild(configFor(fake.url, 150)).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, "settlement_unreachable");
  } finally {
    await fake.close();
  }
});

test("a non-2xx response is a 500 settlement_run_failed — the call landed, settlement itself refused", async () => {
  for (const status of [401, 400, 500]) {
    const fake = await startFakeSettlement((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("nope");
    });
    try {
      const err = await triggerSettlementRunBatch(configFor(fake.url), { date: "2026-09-09" }).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof AppError, `status ${status}`);
      assert.equal(err.statusCode, 500);
      assert.equal(err.code, "settlement_run_failed");
    } finally {
      await fake.close();
    }
  }
});

test("a non-2xx body from settlement is never echoed in the AppError; Go's safe 4xx error code is kept", async () => {
  const leaky = 'pq: relation "x" does not exist SELECT * FROM merchants';
  const fake = await startFakeSettlement((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(leaky);
  });
  const realError = console.error;
  console.error = () => {};
  try {
    const err = await triggerSettlementRunBatch(configFor(fake.url), { date: "2026-09-09" }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "settlement_run_failed");
    assert.ok(!err.message.includes("pq:") && !err.message.includes("SELECT"), err.message);
  } finally {
    console.error = realError;
    await fake.close();
  }

  const bad = await startFakeSettlement((_req, res) => sendJson(res, 400, { error: "invalid_date" }));
  try {
    const err = await triggerSettlementRunBatch(configFor(bad.url), { date: "x" }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AppError);
    assert.ok(err.message.includes("invalid_date"), err.message);
  } finally {
    await bad.close();
  }
});

test("a 200 with unparseable JSON is settlement_run_failed, not a crash", async () => {
  const fake = await startFakeSettlement((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{not json");
  });
  try {
    const err = await triggerBalanceRebuild(configFor(fake.url)).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "settlement_run_failed");
  } finally {
    await fake.close();
  }
});

// FH: fake http server, never touches real settlement — so says nothing about what Go actually rebuilds
test("triggerBalanceRebuild surfaces only the merchants whose balance actually changed", async () => {
  const fake = await startFakeSettlement((_req, res) => {
    // map[uuid.UUID]ledger.RebuildDiff, JSON-encoded: keyed by merchant id.
    sendJson(res, 200, {
      "11111111-1111-1111-1111-111111111111": {
        MerchantID: "11111111-1111-1111-1111-111111111111",
        CachedBefore: 100,
        Rebuilt: 250,
      },
      "22222222-2222-2222-2222-222222222222": {
        MerchantID: "22222222-2222-2222-2222-222222222222",
        CachedBefore: 5_000,
        Rebuilt: 5_000,
      },
      "33333333-3333-3333-3333-333333333333": {
        MerchantID: "33333333-3333-3333-3333-333333333333",
        CachedBefore: 7,
        Rebuilt: 0,
      },
    });
  });
  try {
    const summary = await triggerBalanceRebuild(configFor(fake.url));
    assert.equal(fake.requests[0]!.path, "/internal/rebuild-balances");
    assert.equal(fake.requests[0]!.authorization, "Bearer test-settlement-token");
    assert.equal(summary.rebuiltCount, 3, "every examined merchant is counted");
    assert.equal(summary.changed.length, 2, "only the ones that differed are surfaced");
    assert.deepEqual(
      summary.changed.map((c) => c.merchantId).sort(),
      ["11111111-1111-1111-1111-111111111111", "33333333-3333-3333-3333-333333333333"],
    );
    const first = summary.changed.find((c) => c.merchantId.startsWith("1111"));
    assert.deepEqual(first, {
      merchantId: "11111111-1111-1111-1111-111111111111",
      before: 100,
      after: 250,
    });
  } finally {
    await fake.close();
  }
});

test("triggerBalanceRebuild falls back to the map key when the value carries no merchant id", async () => {
  const fake = await startFakeSettlement((_req, res) => {
    sendJson(res, 200, {
      "55555555-5555-5555-5555-555555555555": { cachedBefore: 1, rebuilt: 2 },
    });
  });
  try {
    const summary = await triggerBalanceRebuild(configFor(fake.url));
    assert.deepEqual(summary.changed, [
      { merchantId: "55555555-5555-5555-5555-555555555555", before: 1, after: 2 },
    ]);
  } finally {
    await fake.close();
  }
});
