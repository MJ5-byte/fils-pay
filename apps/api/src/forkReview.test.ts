/** Focused regressions: injected database/transport only; no services or live sends. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { assertDistinctApprover } from "./admin/creditApproval.js";
import { rotateApiKeyAsAdmin } from "./admin/apiKeys.js";
import { resolveReportMerchantId } from "./reporting/scope.js";
import { runDispatchPass } from "./webhooks/dispatcher.js";
import { sendTestWebhookEvent } from "./webhooks/testSend.js";
import { encryptSecret } from "./webhooks/secretCrypto.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./webhooks/headers.js";
import type { WebhookTransportRequest } from "./webhooks/transport.js";

test("credit approval rejects the same identity after a display-name change", () => {
  assert.throws(() => assertDistinctApprover(
    { adminUserId: "maker", displayName: "Old name" },
    { adminUserId: "maker", displayName: "New name" },
  ), /self_approval_forbidden/);
});

test("credit approval accepts different identities sharing a display name", () => {
  assert.doesNotThrow(() => assertDistinctApprover(
    { adminUserId: "maker", displayName: "Dana" },
    { adminUserId: "checker", displayName: "Dana" },
  ));
});

function reportPool() {
  return { query: async (sql: string, values: string[]) => {
    assert.match(sql, /parent_merchant_id = \$2/);
    // One real relationship in this fixture: parent -> child.
    return { rows: values[0] === "child" && values[1] === "parent" ? [{ ok: 1 }] : [] };
  } } as unknown as Pool;
}

test("report scope permits a parent's own child and rejects an unrelated caller", async () => {
  assert.equal(await resolveReportMerchantId(reportPool(), "parent", "child"), "child");
  assert.equal(await resolveReportMerchantId(reportPool(), "unrelated", "child"), "unrelated");
  assert.equal(await resolveReportMerchantId(reportPool(), "child", "parent"), "child");
});

test("own report scope does not require a relationship lookup", async () => {
  const pool = { query: () => { throw new Error("unexpected query"); } } as unknown as Pool;
  assert.equal(await resolveReportMerchantId(pool, "self"), "self");
  assert.equal(await resolveReportMerchantId(pool, "self", "self"), "self");
});

function rotationFixture(failAudit = false, owner = "merchant") {
  let revoked = false;
  let issued = false;
  let released = false;
  const statements: string[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (sql === "ROLLBACK") { revoked = false; issued = false; }
      if (sql.includes("SELECT id, label, revoked_at")) {
        return { rows: values[1] === owner ? [{ id: "old", label: "integration", revoked_at: null }] : [] };
      }
      if (sql.startsWith("UPDATE api_keys SET revoked_at")) {
        assert.deepEqual(values, ["old", "merchant"]);
        revoked = true;
      }
      if (sql.includes("INSERT INTO api_keys")) {
        assert.ok(revoked, "the replacement must retire its predecessor");
        issued = true;
        return { rows: [{ id: "replacement", created_at: new Date() }] };
      }
      if (sql.includes("INSERT INTO admin_audit_log")) {
        if (failAudit) throw new Error("audit unavailable");
        return { rows: [{ id: "audit" }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    state: () => ({ revoked, issued, released, statements }),
  };
}

const rotationInput = { merchantId: "merchant", apiKeyId: "old", adminUserId: "admin" };

test("key rotation revokes, issues and audits within one transaction", async () => {
  const fixture = rotationFixture();
  const result = await rotateApiKeyAsAdmin(fixture.pool, { nodeEnv: "test" }, rotationInput);
  assert.equal(result.previousKeyId, "old");
  assert.equal(result.id, "replacement");
  const state = fixture.state();
  assert.ok(state.revoked && state.issued && state.released);
  assert.equal(state.statements[0], "BEGIN");
  assert.equal(state.statements.at(-1), "COMMIT");
});

test("failed rotation rolls back revocation and replacement together", async () => {
  const fixture = rotationFixture(true);
  await assert.rejects(rotateApiKeyAsAdmin(fixture.pool, { nodeEnv: "test" }, rotationInput), /audit unavailable/);
  const state = fixture.state();
  assert.equal(state.revoked, false);
  assert.equal(state.issued, false);
  assert.ok(state.released);
  assert.equal(state.statements.at(-1), "ROLLBACK");
});

test("rotation cannot retire another merchant's key", async () => {
  const fixture = rotationFixture(false, "other-merchant");
  await assert.rejects(rotateApiKeyAsAdmin(fixture.pool, { nodeEnv: "test" }, rotationInput), /api_key_not_found/);
  assert.equal(fixture.state().revoked, false);
  assert.equal(fixture.state().issued, false);
});

const key = Buffer.alloc(32, 7);
const secret = "whsec_review_fixture";
const ciphertext = encryptSecret(secret, key);
const webhookConfig = {
  webhookSecretEncryptionKey: key.toString("base64"),
  webhookRequestTimeoutMs: 1000,
  webhookMaxAttempts: 3,
  webhookBackoffBaseMs: 100,
  webhookBackoffCapMs: 1000,
};

function assertRawBodySignature(request: WebhookTransportRequest): void {
  const header = request.headers[WEBHOOK_SIGNATURE_HEADER]!;
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  assert.ok(match);
  const expected = createHmac("sha256", secret).update(`${match[1]}.${request.body}`).digest("hex");
  assert.equal(match[2], expected, "independent receiver HMAC must match the raw HTTP body");
}

test("dispatcher signs its actual bytes, including nested keys and Unicode", async () => {
  const sent: WebhookTransportRequest[] = [];
  const query = async (sql: string) => {
    if (sql.includes("SELECT oe.id AS outbox_event_id")) return { rows: [] };
    if (sql.includes("SELECT wd.id")) return { rows: [{
      id: "delivery", endpoint_id: "endpoint", event_type: "refund.succeeded",
      delivery_event_id: "event", attempt_count: 0, url: "https://receiver.invalid",
      secret_ciphertext: ciphertext,
      payload: { z: "سياق", a: { z: 1, a: "quoted\"value" } },
    }] };
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const result = await runDispatchPass(pool, async request => {
    sent.push(request);
    return { statusCode: 200, body: "ok" };
  }, webhookConfig);
  assert.equal(result.attemptedCount, 1);
  assert.equal(sent.length, 1);
  // Assert outside the transport callback: dispatch intentionally catches
  // transport exceptions, including assertion errors thrown inside a stub.
  assertRawBodySignature(sent[0]!);
});

test("send-test path also signs its actual HTTP body", async () => {
  const pool = { query: async () => ({ rows: [{
    url: "https://receiver.invalid", status: "active", secret_ciphertext: ciphertext,
  }] }) } as unknown as Pool;
  let sends = 0;
  const result = await sendTestWebhookEvent(pool, webhookConfig, async request => {
    sends++;
    assertRawBodySignature(request);
    return { statusCode: 200, body: "ok" };
  }, { merchantId: "merchant", endpointId: "endpoint" });
  assert.equal(result.statusCode, 200);
  assert.equal(sends, 1);
});
