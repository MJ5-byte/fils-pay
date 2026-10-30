import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const DATABASE_URL = "postgres://unused/unused";

for (const nodeEnv of [undefined, "development", "test"]) {
  test(`loadConfig boots without WEBHOOK_SECRET_ENCRYPTION_KEY when NODE_ENV=${nodeEnv ?? "(unset)"}`, () => {
    const config = loadConfig({ DATABASE_URL, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) });
    assert.equal(Buffer.from(config.webhookSecretEncryptionKey, "base64").length, 32);
  });
}

test("loadConfig still requires WEBHOOK_SECRET_ENCRYPTION_KEY in production", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL,
        NODE_ENV: "production",
        SETTLEMENT_INTERNAL_TOKEN: "t",
        ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
      }),
    /WEBHOOK_SECRET_ENCRYPTION_KEY environment variable is not set/,
  );
});
