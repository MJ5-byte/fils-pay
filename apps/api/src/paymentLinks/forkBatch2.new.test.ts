import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { payPaymentLink } from "./pay.js";
import { cancelPaymentLink } from "./cancel.js";
import { getPublicPaymentLink } from "./read.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import { loadConfig } from "../config.js";
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:6});
test.after(()=>pool.end());
const config=loadConfig({DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:"test",INTERNAL_API_TOKEN:"test-internal-token",WEBHOOK_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64"),ACQUIRER_FAILURE_RATE:"0",ACQUIRER_LATENCY_MIN_MS:"0",ACQUIRER_LATENCY_MAX_MS:"1"});
const card={pan:"4242424242424242",expiryMonth:12,expiryYear:2030,cvv:"123"};
const settings={paymentLinkReservationTimeoutSeconds:1};
async function fixture(discount=0){
 const m=(await pool.query("INSERT INTO merchants (display_name,mdr_bps,onboarding_status,negotiated_discount_bps) VALUES ('Fork links',250,'approved',$1) RETURNING id",[discount])).rows[0].id as string;
 const token=`plink_${randomUUID()}`;
 const l=(await pool.query("INSERT INTO payment_links (merchant_id,token,amount_fils,expires_at,created_by_type,created_by_id) VALUES ($1,$2,10000,now()+interval '1 hour','merchant_session',$3) RETURNING id",[m,token,randomUUID()])).rows[0].id as string;
 return {merchantId:m,token,id:l};
}
function simulator(){return createAcquirerSimulator(config);}
const input=(token:string,key=randomUUID())=>({token,card,idempotencyKey:key});
async function stale(id:string){await pool.query("UPDATE payment_links SET reserved_at=now()-interval '2 minutes' WHERE id=$1",[id]);}
async function txnCount(merchantId:string){return (await pool.query("SELECT count(*)::int n FROM transactions WHERE merchant_id=$1",[merchantId])).rows[0].n;}
test("expired checkout ignores spoofed submittedAt without contacting acquirer",async()=>{
 const l=await fixture();await pool.query("UPDATE payment_links SET expires_at=now()-interval '1 minute' WHERE id=$1",[l.id]);
 const r=await payPaymentLink(pool,simulator(),settings,{...input(l.token),submittedAt:"2020-01-01T00:00:00Z"});assert.equal(r.statusCode,410);assert.equal(await txnCount(l.merchantId),0);
});
test("slow capture cannot be overtaken after timeout; cancellation cannot steal reservation",async()=>{
 const l=await fixture();const acq=simulator();let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);let captures=0;
 const slow={...acq,capture:async(req:Parameters<typeof acq.capture>[0])=>{captures++;entered();await gate;return acq.capture(req);}};
 const first=payPaymentLink(pool,slow,settings,input(l.token));await started;
 try {await stale(l.id);const second=await payPaymentLink(pool,acq,settings,input(l.token));assert.equal(second.statusCode,409);assert.equal((await cancelPaymentLink(pool,{id:l.id,merchantId:l.merchantId})).outcome,"not_cancelable");}
 finally{finish();await first;}
 assert.equal(captures,1);assert.equal(await txnCount(l.merchantId),1);
});
test("same-key retry recovers crash after authorize and different payer cannot resume",async()=>{
 const l=await fixture();const acq=simulator();const request=input(l.token);let authorizations=0;
 const crashing={...acq,authorize:async(req:Parameters<typeof acq.authorize>[0])=>{authorizations++;return acq.authorize(req);},capture:async()=>{throw Error("simulated crash before capture");}};
 await assert.rejects(payPaymentLink(pool,crashing,settings,request),/simulated crash/);await stale(l.id);
 assert.equal((await payPaymentLink(pool,acq,settings,input(l.token))).statusCode,409);
 assert.equal((await payPaymentLink(pool,acq,settings,request)).statusCode,200);assert.equal(authorizations,1);assert.equal(await txnCount(l.merchantId),1);
});
test("same-key retry recovers committed capture before finalize, discount applied exactly once",async()=>{
 const l=await fixture(1000);const acq=simulator();const request=input(l.token);let calls=0;
 const counted={...acq,capture:async(req:Parameters<typeof acq.capture>[0])=>{calls++;return acq.capture(req);}};
 const broken={connect:pool.connect.bind(pool),query:async(sql:string,args:unknown[])=>{if(sql.includes("SET status = 'paid'"))throw Error("simulated finalize crash");return pool.query(sql,args);}} as unknown as Pool;
 await assert.rejects(payPaymentLink(broken,counted,settings,request),/simulated finalize crash/);await stale(l.id);
 const r=await payPaymentLink(pool,counted,settings,request);assert.equal(r.statusCode,200);assert.equal(calls,1);
 assert.deepEqual(await payPaymentLink(pool,counted,settings,request),r);
 const net=(await pool.query("SELECT sum(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END)::int fee FROM ledger_entries WHERE merchant_id=$1 AND account_id='platform_fee_revenue'",[l.merchantId])).rows[0].fee;
 assert.equal(net,225);assert.equal(await txnCount(l.merchantId),1);
 assert.equal((await payPaymentLink(pool,counted,settings,{...request,card:{...card,cvv:"999"}})).statusCode,422);
});
test("definitive capture decline voids authorization and releases hold before another payer",async()=>{
 const l=await fixture();const acq=simulator();const declined={...acq,capture:async()=>({outcome:"declined" as const,acquirerReference:"decline",latencyMs:0})};
 assert.equal((await payPaymentLink(pool,declined,settings,input(l.token))).statusCode,402);
 const holds=await pool.query("SELECT h.status FROM holds h JOIN transactions t ON t.id=h.transaction_id WHERE t.merchant_id=$1",[l.merchantId]);
 assert.equal(holds.rows[0].status,"released");assert.equal((await payPaymentLink(pool,acq,settings,input(l.token))).statusCode,200);
});
test("cross-merchant cancellation returns not_found and preserves link",async()=>{
 const a=await fixture();const b=await fixture();assert.equal((await cancelPaymentLink(pool,{id:a.id,merchantId:b.merchantId})).outcome,"not_found");
 assert.equal((await getPublicPaymentLink(pool,a.token,1))!.status,"active");
});
test("public checkout never exposes a merchant API key hash",async()=>{
 const l=await fixture();const u=(await pool.query("INSERT INTO merchant_users (merchant_id,email,password_hash,role) VALUES ($1,$2,'unused','owner') RETURNING id",[l.merchantId,`${randomUUID()}@fork.test`])).rows[0].id;
 const hash="a".repeat(64);await pool.query("INSERT INTO api_keys (merchant_id,key_hash,key_prefix,created_by) VALUES ($1,$2,'fp_test',$3)",[l.merchantId,hash,u]);
 assert.equal(JSON.stringify(await getPublicPaymentLink(pool,l.token,1)).includes(hash),false);
});
