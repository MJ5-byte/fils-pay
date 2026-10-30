import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint, validateWebhookUrl } from "./create.js";
import { createFetchTransport, type WebhookTransportRequest } from "./transport.js";
import { runDispatchPass, startWebhookDispatcher } from "./dispatcher.js";
import { replayWebhookDelivery } from "./replay.js";
import { deleteWebhookEndpoint } from "./cancel.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import { buildApp } from "../app.js";
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:8});
const config=loadConfig({DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:"test",INTERNAL_API_TOKEN:"test-internal-token",WEBHOOK_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64"),ACQUIRER_CALLBACK_SIGNING_SECRET:"fork-callback-secret",ACQUIRER_CALLBACK_REQUIRE_SIGNATURE:"true"});
test.after(()=>pool.end());
async function endpoint(){const m=(await pool.query("INSERT INTO merchants (display_name,mdr_bps) VALUES ('Fork hooks',250) RETURNING id")).rows[0].id as string;
 const e=await createWebhookEndpoint(pool,config,{merchantId:m,url:`http://receiver.test/${randomUUID()}`,createdByType:"merchant_session",createdById:randomUUID()});
 const id=await enqueueEvent(pool,{eventType:"refund.succeeded",aggregateType:"transaction",aggregateId:randomUUID(),payload:{merchantId:m,refundId:randomUUID(),amountFils:1000,feeReversedFils:25,refundedTotalFils:1000,newStatus:"partially_refunded"}});
 return {m,e,event:id};}
test("production URLs reject internal, encoded, trailing-dot and metadata targets",()=>{
 for(const host of ["127.0.0.1","127.1","2130706433","10.1.2.3","172.16.0.1","192.168.1.1","169.254.169.254","100.64.0.1","localhost.","settlement.","service.internal.","[::1]","[::ffff:127.0.0.1]","[fc00::1]","[fe80::1]"]){assert.throws(()=>validateWebhookUrl(`https://${host}/`,{nodeEnv:"production"}),{code:"invalid_url"},host);}
});
test("transport rejects public host DNS resolving to private network",async()=>{
 const send=createFetchTransport({nodeEnv:"production"},async()=>[{address:"127.0.0.1",family:4}]);
 const r=await send({url:"https://receiver.test/",headers:{},body:"{}",timeoutMs:500});assert.equal(r.statusCode,null);assert.match(r.errorMessage!,/non-public/);
});
test("real transport does not follow redirects and caps response memory",async()=>{
 let privateHits=0;const s=createServer((req,res)=>{if(req.url==="/redirect"){res.writeHead(302,{location:"/private"});res.end();}else if(req.url==="/private"){privateHits++;res.end("internal");}else res.end("x".repeat(256*1024));});
 await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const address=s.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;const send=createFetchTransport({nodeEnv:"test"});
 try{assert.equal((await send({url:base+"/redirect",headers:{},body:"{}",timeoutMs:2000})).statusCode,302);assert.equal(privateHits,0);assert.equal((await send({url:base+"/large",headers:{},body:"{}",timeoutMs:2000})).body.length,65536);}finally{await new Promise<void>(r=>s.close(()=>r()));}
});
test("parallel dispatchers send one refund event and sign exactly the body bytes",async()=>{
 const f=await endpoint();let calls=0;const sender=async(req:WebhookTransportRequest)=>{if(req.url===f.e.url){calls++;const header=req.headers[WEBHOOK_SIGNATURE_HEADER]!;const t=header.split(",")[0]!.slice(2);assert.equal(header,`t=${t},v1=${createHmac("sha256",f.e.secret).update(`${t}.${req.body}`).digest("hex")}`);assert.equal(JSON.parse(req.body).type,"refund.succeeded");await new Promise(r=>setTimeout(r,25));}return {statusCode:200,body:"ok"};};
 await Promise.all([runDispatchPass(pool,sender,config),runDispatchPass(pool,sender,config)]);assert.equal(calls,1);
});
test("replay retains delivery ID; deleting endpoint with history disables safely",async()=>{
 const f=await endpoint();await runDispatchPass(pool,async()=>({statusCode:200,body:"ok"}),config);
 const original=(await pool.query("SELECT id,delivery_event_id FROM webhook_deliveries WHERE endpoint_id=$1 AND replay_of_delivery_id IS NULL",[f.e.id])).rows[0];
 const replay=await replayWebhookDelivery(pool,{merchantId:f.m,endpointId:f.e.id,deliveryId:original.id});
 const row=(await pool.query("SELECT delivery_event_id,payload FROM webhook_deliveries WHERE id=$1",[replay.deliveryId])).rows[0];assert.equal(row.delivery_event_id,original.delivery_event_id);assert.equal(row.payload.id,original.delivery_event_id);
 assert.equal(await deleteWebhookEndpoint(pool,{merchantId:f.m,id:f.e.id}),"deleted");assert.equal((await pool.query("SELECT status FROM webhook_endpoints WHERE id=$1",[f.e.id])).rows[0].status,"disabled");
});
test("callback signatures verify raw JSON whitespace and reject stale signatures",async()=>{
 const app=buildApp(config,pool);try{
 const m=(await pool.query("INSERT INTO merchants (display_name,mdr_bps) VALUES ('Callback raw',250) RETURNING id")).rows[0].id;
 const tx=(await pool.query("INSERT INTO transactions (merchant_id,status,amount_fils,captured_fils,acquirer_reference) VALUES ($1,'captured',1000,1000,'fork-ref') RETURNING id",[m])).rows[0].id;
 const raw=JSON.stringify({callbackId:randomUUID(),type:"fraud_review.completed",transactionId:tx,occurredAt:new Date().toISOString(),outcome:"cleared",note:"raw signature"},null,2);
 const request=(time:number)=>app.inject({method:"POST",url:"/v1/acquirer/callbacks",headers:{"content-type":"application/json","acquirer-callback-signature":`t=${time},v1=${createHmac("sha256",config.acquirerCallbackSigningSecret).update(`${time}.${raw}`).digest("hex")}`},payload:raw});
 const r=await request(Math.floor(Date.now()/1000));assert.equal(r.statusCode,200,r.body);assert.equal((await request(1)).statusCode,401);
 }finally{await app.close();}
});
test("LISTEN reconnects after backend loss and stop closes replacement",async()=>{
 const handle=startWebhookDispatcher(pool,async()=>({statusCode:200,body:"ok"}),{...config,webhookPollIntervalMs:20});
 async function listener(exclude=0){for(let i=0;i<100;i++){const r=await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name='filspay-webhook-listener' AND datname=current_database() AND pid<>$1",[exclude]);if(r.rows[0])return r.rows[0].pid as number;await new Promise(r=>setTimeout(r,20));}throw Error("LISTEN connection did not become ready");}
 try{const old=await listener();await pool.query("SELECT pg_terminate_backend($1)",[old]);assert.notEqual(await listener(old),old);}finally{await handle.stop();}
 assert.equal((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='filspay-webhook-listener' AND datname=current_database()")).rows[0].n,0);
});
