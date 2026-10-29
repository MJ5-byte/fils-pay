import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenError } from "../lib/errors.js";
import { requireMerchantWriterActor } from "./requireMerchantAuth.js";

test("requireMerchantWriterActor refuses an impersonation grant instead of recording it as the merchant", () => {
  assert.throws(
    () =>
      requireMerchantWriterActor({
        merchantId: "m1",
        actorType: "admin_impersonation",
        actorId: "grant-1",
        role: "support",
        impersonatedByAdminUserId: "admin-1",
      }),
    ForbiddenError,
  );
});

test("requireMerchantWriterActor attributes sessions and API keys to themselves", () => {
  assert.deepEqual(
    requireMerchantWriterActor({ merchantId: "m1", actorType: "merchant_session", actorId: "s1", role: "owner" }),
    { type: "merchant_session", id: "s1" },
  );
  assert.deepEqual(
    requireMerchantWriterActor({ merchantId: "m1", actorType: "merchant_api_key", actorId: "k1", role: null }),
    { type: "merchant_api_key", id: "k1" },
  );
});
