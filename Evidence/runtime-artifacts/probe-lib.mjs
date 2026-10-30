import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {session,artifacts,root,evidence,updateFinding,timestamp} from './investigate.mjs';
export {assert,crypto,fs,path,artifacts,root,evidence,updateFinding,timestamp};
export const s=session();export const require=createRequire(path.join(s.checkout,'package.json'));
export const source=p=>import(pathToFileURL(path.join(s.checkout,p)).href);
export const {Pool,Client}=require('pg');
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
export const runName=path.basename(process.argv[1]);
export async function database(tag){
 const name='fils_probe_'+tag+'_'+crypto.randomBytes(3).toString('hex');
 const admin=new Client({connectionString:s.base+'/postgres'});await admin.connect();await admin.query('CREATE DATABASE '+name);await admin.end();
 const url=s.base+'/'+name;const c=new Client({connectionString:url});await c.connect();
 const omitted=[];
 for(const name of fs.readdirSync(path.join(s.checkout,'db/migrations')).filter(x=>x.endsWith('.sql')).sort()){
  await c.query('BEGIN');try{await c.query(fs.readFileSync(path.join(s.checkout,'db/migrations',name),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');omitted.push({name,code:e.code,message:e.message});}
 }
 await c.end();s.probeDatabases??=[];s.probeDatabases.push({name,url,tag,omitted});fs.writeFileSync(path.join(artifacts,'session.json'),JSON.stringify(s,null,2));
 return {pool:new Pool({connectionString:url,max:30,connectionTimeoutMillis:3000}),url,name,omitted};
}
export async function merchant(pool,overrides={}){
 const r=await pool.query("INSERT INTO merchants(display_name,onboarding_status,mdr_bps,test_mode,negotiated_discount_bps) VALUES($1,$2,$3,$4,$5) RETURNING id",['Forensic synthetic '+crypto.randomBytes(3).toString('hex'),overrides.onboarding_status||'approved',overrides.mdr_bps??250,overrides.test_mode??false,overrides.discount_bps??0]);return r.rows[0].id;
}
export async function user(pool,merchantId,{role='owner',email,passwordHash='synthetic-unusable-hash'}={}){
 const r=await pool.query('INSERT INTO merchant_users(merchant_id,email,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id',[merchantId,email||crypto.randomUUID()+'@forensic.invalid',role,passwordHash]);return r.rows[0].id;
}
export async function admin(pool,role='finance'){
 const r=await pool.query('INSERT INTO admin_users(email,password_hash,display_name,role) VALUES($1,$2,$3,$4) RETURNING id',[crypto.randomUUID()+'@forensic.invalid','synthetic-unusable-hash','Forensic '+role,role]);return r.rows[0].id;
}
export async function txn(pool,merchantId,{amount=1000,captured=0,refunded=0,status=captured===0?'authorized':captured===amount?'captured':'partially_captured',occurredAt=new Date()}={}){
 const r=await pool.query('INSERT INTO transactions(merchant_id,status,amount_fils,captured_fils,refunded_fils,acquirer_reference,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[merchantId,status,amount,captured,refunded,'synthetic_'+crypto.randomUUID(),occurredAt]);return r.rows[0].id;
}
export const approved={authorize:async()=>({outcome:'approved',acquirerReference:'synthetic_'+crypto.randomUUID(),latencyMs:0}),capture:async()=>({outcome:'approved',acquirerReference:'synthetic_'+crypto.randomUUID(),latencyMs:0}),refund:async()=>({outcome:'approved',acquirerReference:'synthetic_'+crypto.randomUUID(),latencyMs:0})};
export async function authenticatedCookie(pool,userId,config,{authenticated=true}={}){
 const token=crypto.randomBytes(32).toString('hex');await pool.query('INSERT INTO sessions(merchant_user_id,token_hash,authenticated,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',[userId,crypto.createHash('sha256').update(token).digest('hex'),authenticated]);return {[config.cookieName]:token};
}
export async function appFor(pool,url){
 const {loadConfig}=await source('apps/api/src/config.ts');const {buildApp}=await source('apps/api/src/app.ts');
 const config=loadConfig({NODE_ENV:'test',DATABASE_URL:url,WEBHOOK_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),ACQUIRER_LATENCY_MIN_MS:'0',ACQUIRER_LATENCY_MAX_MS:'0',ACQUIRER_FAILURE_RATE:'0',KYC_UPLOAD_DIR:path.join(s.temp,'probe-kyc')});
 const app=buildApp(config,pool,{webhookTransport:async()=>({statusCode:204,body:''})});app.log.level='silent';await app.ready();return {app,config};
}
export async function probe(id,title,related,fn,options={}){
 const start=timestamp();let result;let status='REPRODUCED';
 try{result=await fn();}catch(e){status='FAILED ATTEMPT';result={name:e.name,message:e.message,code:e.code,stack:e.stack};}
 const record={timestamp:start,completed:timestamp(),id,title,related,status,...result};
 fs.appendFileSync(path.join(artifacts,'probe-results.ndjson'),JSON.stringify(record)+'\n');
 const e=evidence(`${id} — ${title}`,`**Status:** ${status}. **Related:** ${related||'New discovery'}. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** \`node Evidence/runtime-artifacts/run-probes.mjs ${runName}\`.\n\n**Inputs, expectations, sanitized observations and limits:**\n\n\`\`\`json\n${JSON.stringify(result,null,2)}\n\`\`\`\n\nMachine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record \`${id}\`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.`);
 if(status==='REPRODUCED'&&related?.startsWith('FINDING-'))updateFinding(related,options.status||'REPRODUCED',e,options.notes||`${title}; local synthetic reproduction (${id}).`);
 console.log(JSON.stringify({id,status,evidence:e,...result}));return {status,result,evidence:e};
}
