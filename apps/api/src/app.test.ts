/**
 * Route-level tests, using Fastify's `app.inject(...)` against `buildApp()`
 * — no real socket. These exercise the main auth/onboarding flows against a
 * real, migrated Postgres (no mocking of the DB layer), so this file
 * requires `DATABASE_URL` to point at one (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const savedLogLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = "debug";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "app.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const kycUploadDir = mkdtempSync(join(tmpdir(), "filspay-kyc-test-"));

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  KYC_UPLOAD_DIR: kycUploadDir,
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
  await rm(kycUploadDir, { recursive: true, force: true });
  if (savedLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = savedLogLevel;
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

function businessProfilePayload(nameSuffix: string) {
  return {
    legalName: `Test Co ${nameSuffix}`,
    registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
    businessType: "llc" as const,
    contactEmail: uniqueEmail("contact"),
    contactPhone: "+97300000000",
    addressLine1: "1 Test Street",
    city: "Manama",
  };
}

function parseCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!header) throw new Error("expected a Set-Cookie header in the response");
  return header.split(";")[0] as string;
}

async function signup(emailPrefix: string, password: string, email = uniqueEmail(emailPrefix)) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: { businessProfile: businessProfilePayload(emailPrefix), owner: { email, password } },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { merchantId: string; ownerUserId: string; onboardingStatus: string };
  assert.equal(body.onboardingStatus, "submitted");
  return { merchantId: body.merchantId, email, password };
}

/** Full signup -> login -> otp verify, returning an authenticated cookie. */
async function signupLoginAndVerify(emailPrefix: string) {
  const password = "correct horse battery staple 1!";
  const { merchantId, email } = await signup(emailPrefix, password);

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { otpRequired: boolean; devOtpCode?: string };
  assert.equal(loginBody.otpRequired, true);
  assert.ok(loginBody.devOtpCode, "expected devOtpCode with OTP_DEV_EXPOSE=true");
  const cookie = parseCookie(loginRes.headers["set-cookie"]);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);

  return { merchantId, email, password, cookie };
}

function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----filspayTestBoundary${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

test("signup -> login -> otp verify -> authenticated /v1/auth/me", async () => {
  const { merchantId, email, cookie } = await signupLoginAndVerify("flow");

  const meRes = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(meRes.statusCode, 200, meRes.body);
  const meBody = meRes.json();
  assert.equal(meBody.email, email);
  assert.equal(meBody.role, "owner");
  assert.equal(meBody.merchant.id, merchantId);
  assert.equal(meBody.merchant.onboardingStatus, "submitted");
});

test("a second merchant sharing the same owner email resolves correctly via required merchantId", async () => {
  const email = uniqueEmail("shared");
  const passwordA = "password-for-merchant-a-1234";
  const passwordB = "password-for-merchant-b-5678";

  const { merchantId: merchantAId } = await signup("shared-a", passwordA, email);
  const { merchantId: merchantBId } = await signup("shared-b", passwordB, email);
  assert.notEqual(merchantAId, merchantBId);

  const loginA = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: merchantAId, email, password: passwordA },
  });
  assert.equal(loginA.statusCode, 200, loginA.body);

  const loginB = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: merchantBId, email, password: passwordB },
  });
  assert.equal(loginB.statusCode, 200, loginB.body);

  // B's password must not authenticate against A's merchant/email pair —
  // proves the lookup is scoped by merchant_id, not resolved by email alone.
  const cross = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: merchantAId, email, password: passwordB },
  });
  assert.equal(cross.statusCode, 401);
  assert.equal(cross.json().error, "invalid_credentials");
});

test("login resolves the OTP recipient to the same account that was authenticated", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("recipient-sanity");

  const meRes = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(meRes.statusCode, 200, meRes.body);
  assert.equal(meRes.json().merchant.id, merchantId);
});

test("login with the wrong password is rejected with a generic invalid_credentials error", async () => {
  const { merchantId, email } = await signup("wrongpw", "the-real-password-123");
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password: "totally-the-wrong-password" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_credentials");
});

test("otp verify with the wrong code is rejected", async () => {
  const password = "another-real-password-456";
  const { merchantId, email } = await signup("wrongotp", password);

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password },
  });
  assert.equal(loginRes.statusCode, 200);
  const cookie = parseCookie(loginRes.headers["set-cookie"]);
  const realCode = (loginRes.json() as { devOtpCode: string }).devOtpCode;

  // A wrong code, deliberately different from the real one.
  const wrongCode = realCode === "000000" ? "111111" : "000000";
  const wrongRes = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: wrongCode },
  });
  assert.equal(wrongRes.statusCode, 401);
  assert.equal(wrongRes.json().error, "invalid_code");

  // The real code still works afterward (one wrong attempt doesn't burn the session).
  const rightRes = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: realCode },
  });
  assert.equal(rightRes.statusCode, 200, rightRes.body);
});

test("KYC upload rejects a fake .pdf whose bytes don't start with %PDF", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("kycfake");

  const { body, contentType } = buildMultipart(
    { documentType: "commercial_registration" },
    { fieldName: "file", filename: "fake.pdf", contentType: "application/pdf", data: Buffer.from("not a real pdf, just text") },
  );

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/kyc/documents`,
    headers: { cookie, "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error, "invalid_file_type");
});

test("KYC upload accepts a real tiny PDF and moves onboarding_status to under_review", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("kycreal");

  const pdfBuffer = Buffer.from("%PDF-1.4\n%mock minimal pdf for test\n%%EOF");
  const { body, contentType } = buildMultipart(
    { documentType: "owner_id" },
    { fieldName: "file", filename: "id.pdf", contentType: "application/pdf", data: pdfBuffer },
  );

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/kyc/documents`,
    headers: { cookie, "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().onboardingStatus, "under_review");

  const meRes = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(meRes.json().merchant.onboardingStatus, "under_review");
});

test("KYC upload accepts a real PDF for commercial_registration regardless of its filename", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("kycnonpdf");

  const pdfBuffer = Buffer.from("%PDF-1.4\n%mock minimal pdf for test\n%%EOF");
  const { body, contentType } = buildMultipart(
    { documentType: "commercial_registration" },
    { fieldName: "file", filename: "registration.docx", contentType: "application/pdf", data: pdfBuffer },
  );

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/kyc/documents`,
    headers: { cookie, "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().onboardingStatus, "under_review");
});

test("KYC upload rejects a PNG renamed .pdf for a PDF-only document type", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("kycpng");

  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { body, contentType } = buildMultipart(
    { documentType: "commercial_registration" },
    { fieldName: "file", filename: "evil.pdf", contentType: "application/pdf", data: pngBuffer },
  );

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/kyc/documents`,
    headers: { cookie, "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error, "document_must_be_pdf");
});

test("API key issuance shows the raw key exactly once; a subsequent list never exposes it", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("apikey");

  const issueRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/api-keys`,
    headers: { cookie },
    payload: { label: "test key" },
  });
  assert.equal(issueRes.statusCode, 201, issueRes.body);
  const issueBody = issueRes.json() as { id: string; prefix: string; rawKey: string };
  assert.ok(issueBody.rawKey.startsWith("fp_test_"));
  assert.equal(issueBody.prefix, issueBody.rawKey.slice(0, 16));

  const listRes = await app.inject({
    method: "GET",
    url: `/v1/merchants/${merchantId}/api-keys`,
    headers: { cookie },
  });
  assert.equal(listRes.statusCode, 200);
  const listBody = listRes.json() as Array<Record<string, unknown>>;
  assert.equal(listBody.length, 1);
  assert.equal(listBody[0]?.id, issueBody.id);

  const serialized = JSON.stringify(listBody);
  assert.equal(serialized.includes(issueBody.rawKey), false, "raw key must never appear in the list response");
  assert.equal("rawKey" in (listBody[0] ?? {}), false);
  assert.equal("keyHash" in (listBody[0] ?? {}), false);
});

test("revoking an API key with a non-UUID id answers 404, not 500 (BHA-77)", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("apikeybadid");
  for (const id of ["not-a-uuid", "123", "%27%20OR%201%3D1"]) {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/merchants/${merchantId}/api-keys/${id}`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 404, `${id}: ${res.body}`);
    assert.equal(res.json().error, "api_key_not_found");
  }
});

test("signup rejects an unknown business type or a badly typed field with 400, not 500 (BHA-99)", async () => {
  const bad = [
    { businessType: "cooperative" },
    { businessType: 7 },
    { legalName: 42 },
    { contactEmail: { a: 1 } },
    { country: "BHR" },
    { city: "Man\u0000ama" },
  ];
  for (const override of bad) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: {
        businessProfile: { ...businessProfilePayload("badsignup"), ...override },
        owner: { email: uniqueEmail("badsignup"), password: "correct horse battery staple 1!" },
      },
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(override)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_business_profile");
  }
});

test("business profile update rejects invalid values and unknown keys with 400 and changes nothing (BHA-100, BHA-101)", async () => {
  const { merchantId, cookie } = await signupLoginAndVerify("bpbad");
  const url = `/v1/merchants/${merchantId}/business-profile`;
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ businessType: "cooperative" }, "invalid_business_profile"],
    [{ legalName: null }, "invalid_business_profile"],
    [{ legalName: "" }, "invalid_business_profile"],
    [{ city: 5 }, "invalid_business_profile"],
    [{ country: "BHR" }, "invalid_business_profile"],
    [{ addressLine2: 5 }, "invalid_business_profile"],
    [{ city: "Man\u0000ama" }, "invalid_business_profile"],
    [{ "city = 'x', merchant_id": "y" }, "unknown_field"],
    [{ merchantId: randomUUID() }, "unknown_field"],
    [{ updatedAt: "2020-01-01" }, "unknown_field"],
    [{ city: "Riffa", surprise: 1 }, "unknown_field"],
  ];
  for (const [patch, code] of bad) {
    const res = await app.inject({ method: "PATCH", url, headers: { cookie }, payload: patch });
    assert.equal(res.statusCode, 400, `${JSON.stringify(patch)}: ${res.body}`);
    assert.equal(res.json().error, code);
    assert.equal(res.body.includes("surprise"), false, "input must not be echoed");
  }
  const after = await app.inject({ method: "GET", url, headers: { cookie } });
  assert.equal(after.json().city, "Manama");

  const ok = await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { city: "Riffa", addressLine2: null } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().city, "Riffa");
});

test("signup refuses a NUL in the owner email and still accepts omitted or null optional fields (BHA-99)", async () => {
  const password = "correct horse battery staple 1!";
  const nul = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: { businessProfile: businessProfilePayload("nulmail"), owner: { email: "a\u0000@example.test", password } },
  });
  assert.equal(nul.statusCode, 400, nul.body);

  const ok = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: { ...businessProfilePayload("nullopt"), addressLine2: null, postalCode: null, country: null },
      owner: { email: uniqueEmail("nullopt"), password },
    },
  });
  assert.equal(ok.statusCode, 201, ok.body);
});
