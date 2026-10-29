/**
 * Tests for bulk KYC approval, against a real, migrated Postgres
 * (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { bulkApproveMerchantsKyc } from "./bulkKyc.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("bulkKyc.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createAdminUser(): Promise<{ id: string; email: string }> {
  const email = `bulk-kyc-${randomUUID()}@admin.test`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Bulk KYC Test', 'finance') RETURNING id`,
    [email],
  );
  return { id: result.rows[0]!.id, email };
}

async function createMerchant(onboardingStatus: "under_review" | "rejected"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode, onboarding_status)
     VALUES ($1, 250, 'active', false, 'under_review') RETURNING id`,
    [`bulk-kyc-merchant-${randomUUID()}`],
  );
  const merchantId = result.rows[0]!.id;
  if (onboardingStatus === "rejected") {
    await recordKycReview(pool, { merchantId, outcome: "rejected", reviewerIdentifier: "test" });
  }
  return merchantId;
}

async function merchantKyc(merchantId: string): Promise<{ onboarding_status: string; kyc_passed: boolean }> {
  const result = await pool.query<{ onboarding_status: string; kyc_passed: boolean }>(
    `SELECT onboarding_status, kyc_passed FROM merchants WHERE id = $1`,
    [merchantId],
  );
  return result.rows[0]!;
}

test("bulk approve skips a rejected merchant and approves the one under review", async () => {
  const admin = await createAdminUser();
  const underReview = await createMerchant("under_review");
  const rejected = await createMerchant("rejected");

  const result = await bulkApproveMerchantsKyc(pool, {
    merchantIds: [underReview, rejected],
    adminUserId: admin.id,
  });

  assert.deepEqual(result, { approvedCount: 1, approvedMerchantIds: [underReview] });
  assert.deepEqual(await merchantKyc(underReview), { onboarding_status: "approved", kyc_passed: true });
  assert.deepEqual(await merchantKyc(rejected), { onboarding_status: "rejected", kyc_passed: false });
});

test("bulk approve writes a review row for each approved merchant", async () => {
  const admin = await createAdminUser();
  const merchantId = await createMerchant("under_review");

  await bulkApproveMerchantsKyc(pool, {
    merchantIds: [merchantId],
    adminUserId: admin.id,
    notes: "batch 7",
  });

  const reviews = await pool.query(
    `SELECT outcome, reviewer_identifier, reviewer_admin_user_id, notes
       FROM merchant_kyc_reviews WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(reviews.rows, [
    {
      outcome: "approved",
      reviewer_identifier: admin.email,
      reviewer_admin_user_id: admin.id,
      notes: "batch 7",
    },
  ]);
});
