// Signs up one merchant (and its owner login) on the live FilsPay API.
//
// 1. Copy merchant-details.example.json to merchant-details.json and replace
//    every "CHANGE ME" (merchant-details.json is gitignored).
// 2. Check it first without sending anything:   node create-merchant.cjs --dry-run
// 3. Create the merchant for real:              node create-merchant.cjs
//
// The owner's password is generated here and saved, together with the
// merchant ID you need to log in, to merchant-login.txt. It is never printed.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API = "https://fp-api-tzakir.dilmune.app";
const LOGIN_URL = "https://fp-pay-tzakir.dilmune.app/dashboard/login";
const BUSINESS_TYPES = ["sole_proprietorship", "llc", "partnership", "public_company", "other"];
const REQUIRED = ["legalName", "registrationNumber", "businessType", "contactEmail", "contactPhone", "addressLine1", "city"];

const dryRun = process.argv.includes("--dry-run");
const detailsFile = path.join(__dirname, "merchant-details.json");
const outFile = path.join(__dirname, "merchant-login.txt");

function fail(message) {
  console.error("Not sent: " + message);
  process.exit(1);
}

let details;
try {
  details = JSON.parse(fs.readFileSync(detailsFile, "utf8"));
} catch (err) {
  fail("could not read merchant-details.json (" + err.message + ")");
}

const bp = details.businessProfile || {};
const owner = details.owner || {};

// Drop empty optional fields so the API stores NULL rather than "".
for (const key of ["addressLine2", "postalCode"]) {
  if (typeof bp[key] === "string" && bp[key].trim() === "") delete bp[key];
}

const problems = [];
for (const key of REQUIRED) {
  if (!bp[key] || !String(bp[key]).trim()) problems.push(`businessProfile.${key} is empty`);
}
if (!owner.email) problems.push("owner.email is empty");
if (JSON.stringify(details).includes("CHANGE ME")) problems.push('some fields still say "CHANGE ME"');
if (bp.businessType && !BUSINESS_TYPES.includes(bp.businessType)) {
  problems.push(`businessType must be one of: ${BUSINESS_TYPES.join(", ")}`);
}
if (bp.country && !/^[A-Z]{2}$/.test(bp.country)) problems.push('country must be a 2-letter code like "BH"');
for (const [label, value] of [["owner.email", owner.email], ["businessProfile.contactEmail", bp.contactEmail]]) {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) problems.push(`${label} doesn't look like an email`);
}
if (owner.email && owner.email !== owner.email.toLowerCase()) {
  problems.push("owner.email should be all lowercase (login matches it exactly)");
}
if (problems.length) fail("\n  - " + problems.join("\n  - "));

if (fs.existsSync(outFile) && !dryRun) {
  fail("merchant-login.txt already exists. Move or delete it first so an earlier login isn't overwritten.");
}

if (dryRun) {
  console.log("Dry run OK. This would create:");
  console.log(`  Business: ${bp.legalName} (${bp.businessType}, ${bp.country || "BH"})`);
  console.log(`  Owner login email: ${owner.email}`);
  console.log("Run again without --dry-run to create it.");
  process.exit(0);
}

const password = crypto.randomBytes(18).toString("base64url");
const body = { businessProfile: bp, owner: { email: owner.email, password } };

fetch(`${API}/v1/merchants`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    const text = await res.text();
    if (res.status !== 201) {
      console.error(`Not created. HTTP ${res.status}: ${text}`);
      process.exit(1);
    }
    const result = JSON.parse(text);
    fs.writeFileSync(
      outFile,
      [
        "FilsPay merchant dashboard",
        `URL: ${LOGIN_URL}`,
        `Merchant ID: ${result.merchantId}`,
        `Email: ${owner.email}`,
        `Password: ${password}`,
        `Onboarding status: ${result.onboardingStatus}`,
        "",
        "Delete this file once you have saved the password in a password manager.",
        "",
      ].join("\n"),
    );
    console.log("Merchant created.");
    console.log(`  Merchant ID: ${result.merchantId}`);
    console.log(`  Onboarding status: ${result.onboardingStatus}`);
    console.log("Login details (including the password) saved to merchant-login.txt");
  })
  .catch((err) => {
    console.error("Request failed, nothing created: " + err.message);
    process.exit(1);
  });
