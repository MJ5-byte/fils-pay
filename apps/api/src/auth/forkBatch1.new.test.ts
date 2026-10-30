import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";
import { sha256Hex } from "../lib/crypto.js";
import { randomDigits, randomFromAlphabet } from "../lib/random.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "test", OTP_DEV_EXPOSE: "true", INTERNAL_API_TOKEN: "test-internal-token", WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), ACQUIRER_FAILURE_RATE: "0", ACQUIRER_LATENCY_MIN_MS: "0", ACQUIRER_LATENCY_MAX_MS: "1" });
const app = buildApp(config, pool);
test.after(async () => { await app.close(); await pool.end(); });
const password = "fork-regression-password-123!";
const cookie = (r: { headers: { [name: string]: unknown } }) => {
  const h = r.headers["set-cookie"];
  assert.ok(h); return String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
};
async function fixture(admin = false, email = `${randomUUID()}@fork.test`) {
  const hash = await hashPassword(password, config);
  if (admin) {
    const r = await pool.query("INSERT INTO admin_users (email, password_hash, role, display_name) VALUES ($1,$2,'super_admin','Fork regression') RETURNING id", [email, hash]);
    return { id: r.rows[0].id as string, email, merchantId: "" };
  }
  const m = await pool.query("INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ('Fork regression',250,'approved') RETURNING id");
  const u = await pool.query("INSERT INTO merchant_users (merchant_id,email,password_hash,role) VALUES ($1,$2,$3,'owner') RETURNING id", [m.rows[0].id,email,hash]);
  return { id: u.rows[0].id as string, email, merchantId: m.rows[0].id as string };
}
async function login(u: Awaited<ReturnType<typeof fixture>>, admin = false, remoteAddress = "127.0.0.1", pass = password) {
  return app.inject({ method: "POST", url: admin ? "/v1/admin/auth/login" : "/v1/auth/login", remoteAddress, payload: { email: u.email, merchantId: u.merchantId, password: pass } });
}
for (const admin of [false,true]) {
  const base = admin ? "/v1/admin/auth" : "/v1/auth";
  test(`${base}: pending denied, OTP rotates token and renews cookie; old token rejected`, async () => {
    const u = await fixture(admin); const l = await login(u,admin); assert.equal(l.statusCode,200,l.body);
    const pending = cookie(l);
    assert.equal((await app.inject({url: `${base}/me`,headers:{cookie:pending}})).statusCode,401);
    const v = await app.inject({method:"POST",url:`${base}/otp/verify`,headers:{cookie:pending},payload:{code:l.json().devOtpCode}});
    assert.equal(v.statusCode,200,v.body); const live = cookie(v); assert.notEqual(live,pending);
    assert.match(String(v.headers["set-cookie"]), new RegExp(`Max-Age=${(admin ? config.adminSessionTtlHours : config.sessionTtlHours) * 3600}`));
    assert.equal((await app.inject({url:`${base}/me`,headers:{cookie:pending}})).statusCode,401);
    assert.equal((await app.inject({url:`${base}/me`,headers:{cookie:live}})).statusCode,200);
  });
  test(`${base}: concurrent guesses cannot exceed the attempt budget`, async () => {
    const u=await fixture(admin);const l=await login(u,admin);const pending=cookie(l);
    const wrong=l.json().devOtpCode === "000000" ? "111111" : "000000";
    const replies=await Promise.all(Array.from({length:12},()=>app.inject({method:"POST",url:`${base}/otp/verify`,headers:{cookie:pending},payload:{code:wrong}})));
    const table=admin ? "admin_otp_challenges" : "otp_challenges";
    const column=admin ? "admin_user_id" : "merchant_user_id";
    const r=await pool.query(`SELECT attempt_count FROM ${table} WHERE ${column}=$1`,[u.id]);
    assert.equal(r.rows[0].attempt_count,5);assert.ok(replies.every(r=>r.statusCode===401 || r.statusCode===429));
  });
  test(`${base}: password limits are scoped by IP and rejected attempts do not extend lockout`,async()=>{
    const u=await fixture(admin); const ip=`198.18.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
    for(let i=0;i<5;i++) assert.equal((await login(u,admin,ip,"wrong")).statusCode,401);
    const refused=await login(u,admin,ip,"wrong");assert.equal(refused.statusCode,429);assert.ok(refused.headers["retry-after"]);
    const count=await pool.query("SELECT count(*)::int n FROM login_failures WHERE ip=$1",[ip]);assert.equal(count.rows[0].n,5);
    assert.equal((await login(u,admin,"192.0.2.200")).statusCode,200);
  });
}
test("shared email login remains bound to the merchant whose password was checked",async()=>{
  const email=`${randomUUID()}@fork.test`;await fixture(false,email);const b=await fixture(false,email);
  const l=await login(b);const v=await app.inject({method:"POST",url:"/v1/auth/otp/verify",headers:{cookie:cookie(l)},payload:{code:l.json().devOtpCode}});
  assert.equal(v.statusCode,200,v.body);assert.equal(v.json().merchantId,b.merchantId);
});
test("resend preserves guess budget and serializes concurrent resends",async()=>{
  const u=await fixture();const l=await login(u);const pending=cookie(l);
  await pool.query("UPDATE otp_challenges SET attempt_count=4, created_at=now()-interval '1 minute' WHERE merchant_user_id=$1",[u.id]);
  const rs=await Promise.all([1,2].map(()=>app.inject({method:"POST",url:"/v1/auth/otp/resend",headers:{cookie:pending}})));
  assert.deepEqual(rs.map(r=>r.statusCode).sort(),[200,429]);
  const r=await pool.query("SELECT c.attempt_count FROM otp_challenges c JOIN sessions s ON s.otp_challenge_id=c.id WHERE s.merchant_user_id=$1",[u.id]);
  assert.equal(r.rows[0].attempt_count,4);
});
test("suspension revokes existing sessions and API keys",async()=>{
  const u=await fixture();const raw=randomUUID();const key=randomUUID();
  await pool.query("INSERT INTO sessions (merchant_user_id,token_hash,authenticated,expires_at) VALUES ($1,$2,true,now()+interval '1 hour')",[u.id,sha256Hex(raw)]);
  await pool.query("INSERT INTO api_keys (merchant_id,key_hash,key_prefix,created_by) VALUES ($1,$2,'test',$3)",[u.merchantId,sha256Hex(key),u.id]);
  await pool.query("UPDATE merchants SET status='suspended' WHERE id=$1",[u.merchantId]);
  assert.equal((await app.inject({url:"/v1/auth/me",headers:{cookie:`${config.cookieName}=${raw}`}})).statusCode,401);
  assert.equal((await app.inject({url:"/v1/transactions",headers:{authorization:`Bearer ${key}`}})).statusCode,401);
});
test("support cannot capture or void",async()=>{
  const u=await fixture();const raw=randomUUID();await pool.query("UPDATE merchant_users SET role='support' WHERE id=$1",[u.id]);
  await pool.query("INSERT INTO sessions (merchant_user_id,token_hash,authenticated,expires_at) VALUES ($1,$2,true,now()+interval '1 hour')",[u.id,sha256Hex(raw)]);
  for(const action of ["capture","void"]) assert.equal((await app.inject({method:"POST",url:`/v1/transactions/${randomUUID()}/${action}`,headers:{cookie:`${config.cookieName}=${raw}`,"idempotency-key":randomUUID()}})).statusCode,403);
});
test("OTP and token helpers never consult Math.random",()=>{
  const original=Math.random;Math.random=()=>{throw Error("insecure RNG used");};
  try {assert.match(randomDigits(6),/^\d{6}$/);assert.match(randomFromAlphabet("abc",32),/^[abc]{32}$/);} finally {Math.random=original;}
});
