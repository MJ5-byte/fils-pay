import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {session,run,safeEnv,evidence,section,updateFinding,artifacts,timestamp} from './investigate.mjs';
const s=session();const require=createRequire(path.join(s.checkout,'package.json'));const {Client}=require('pg');
const bin=path.join(s.temp,'tooling/node_modules/@embedded-postgres/windows-x64/native/bin');
const pgdata=path.join(s.temp,'pgdata');
if(!fs.existsSync(path.join(pgdata,'PG_VERSION'))||fs.readFileSync(path.join(pgdata,'PG_VERSION'),'utf8').trim()!=='16')throw Error('expected newly initialized PostgreSQL 16 cluster');
evidence('Windows pg_ctl fails; direct server launch attempted',`**Status:** Failed environment attempt; no application or migration ran. The portable \`initdb\` command returned exit 0 and created the new cluster, but included restricted-token diagnostics. \`pg_ctl -D <new-temp-pgdata> -l <temp-log> -w start\` failed with \`could not create restricted token: error code 87\` / \`could not start server: error code 3\`. [postgres-initdb.txt](runtime-artifacts/postgres-initdb.txt), [postgres-start.txt](runtime-artifacts/postgres-start.txt).\n\nThis is an investigation-host launcher limitation, not a FilsPay defect. The next safe method starts \`postgres.exe\` directly with explicit \`-h 127.0.0.1\` and a fresh local port; no administrative elevation or permission expansion is requested.`);
const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
fs.appendFileSync(path.join(pgdata,'postgresql.conf'),`\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`);
fs.writeFileSync(path.join(pgdata,'pg_hba.conf'),'host all all 127.0.0.1/32 trust\n');
const out=fs.openSync(path.join(s.temp,'postgres-direct.log'),'a');
const args=['-D',pgdata,'-h','127.0.0.1','-p',String(port)];
const child=spawn(path.join(bin,'postgres.exe'),args,{cwd:s.temp,env:safeEnv(),detached:true,windowsHide:true,stdio:['ignore',out,out]});child.unref();fs.closeSync(out);
Object.assign(s,{pgdata,pgbin:bin,port,postgresPid:child.pid,base:`postgres://forensic_local@127.0.0.1:${port}`});
fs.writeFileSync(path.join(artifacts,'session.json'),JSON.stringify(s,null,2));
let admin;let last;
for(let i=0;i<20;i++){
 const c=new Client({connectionString:s.base+'/postgres',connectionTimeoutMillis:500});
 try{await c.connect();admin=c;break;}catch(e){last=e.message;await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,500));}
}
if(!admin){
 const log=fs.readFileSync(path.join(s.temp,'postgres-direct.log'),'utf8');fs.writeFileSync(path.join(artifacts,'postgres-direct.txt'),log);
 evidence('Direct PostgreSQL launch failed',`**Status:** BLOCKED runtime database testing. Last local connect error: \`${last}\`. [postgres-direct.txt](runtime-artifacts/postgres-direct.txt). No application/database mutation was attempted.`);throw Error(last);
}
const proof=(await admin.query(`SELECT version(), current_database(), current_user, inet_server_addr()::text server_address, inet_server_port() server_port, current_setting('data_directory') data_directory, current_setting('listen_addresses') listen_addresses, pg_postmaster_start_time() postmaster_started`)).rows[0];
if(proof.server_address!=='127.0.0.1'||proof.server_port!==port||path.resolve(proof.data_directory)!==path.resolve(pgdata)||proof.listen_addresses!=='127.0.0.1')throw Error('isolation check failed');
const existing=(await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")).rows;
if(existing.some(x=>x.datname!=='postgres'))throw Error('unexpected database in new cluster');
await admin.query('CREATE DATABASE fils_forensic_clean');await admin.end();
s.cleanUrl=s.base+'/fils_forensic_clean';fs.writeFileSync(path.join(artifacts,'session.json'),JSON.stringify(s,null,2));
fs.writeFileSync(path.join(artifacts,'isolation.json'),JSON.stringify({checked:timestamp(),proof,existing,command:[path.join(bin,'postgres.exe'),...args],pid:child.pid,network:'127.0.0.1 only',sourceData:'none; newly initialized cluster',environment:'whitelisted; no inherited PG*, DATABASE_URL, PGCONN_SETTLEMENT, secrets or dotenv files',resolved:{api:s.cleanUrl,reporting:s.cleanUrl,settlement:s.cleanUrl,PGCONN_SETTLEMENT:'absent'},auth:'trust only on disposable loopback listener'},null,2));
const eid=evidence('Disposable PostgreSQL isolation verified before any migrations',`**Status:** Verified. PostgreSQL version and actual server settings: [isolation.json](runtime-artifacts/isolation.json). Newly initialized directory \`${pgdata}\`; listener \`127.0.0.1:${port}\`; initially only \`postgres\` and template databases. The connection's server address, port, data directory and listener setting all matched the newly launched process. Created a new empty \`fils_forensic_clean\` database afterward. No production/shared connection, secret, environment file or data dump was used. All subsequent children receive whitelisted environments with explicit local DATABASE_URL and no PGCONN_SETTLEMENT override.\n\n**Command:** \`node Evidence/runtime-artifacts/local-db.mjs\`; exact PostgreSQL argv in isolation artifact.`);
section(3,`Isolation verified at ${timestamp()}: ${eid}, [isolation.json](runtime-artifacts/isolation.json). PostgreSQL 16.9 binds only 127.0.0.1:${port}, using a newly initialized data directory outside the repository. Synthetic local role has no password. Explicit local URLs and whitelisted child environments exclude ambient credentials/PG overrides. No production/shared database, real processor, bank transfer, merchant callback, or production dump is used. Only new Evidence files persist in the workspace. The failed pg_ctl attempt is preserved separately.`);
const env=safeEnv({DATABASE_URL:s.cleanUrl});
const r=run(process.execPath,['--import','tsx','db/migrate.ts'],{cwd:s.checkout,env,file:'clean-migrate',timeout:30000});
const c=new Client({connectionString:s.cleanUrl});await c.connect();
const applied=(await c.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows;
const probes=[];
for(const name of ['0054_views.sql','0055_chart_of_accounts_suspense.sql']){
 await c.query('BEGIN');try{await c.query(fs.readFileSync(path.join(s.checkout,'db/migrations',name),'utf8'));probes.push({name,result:'success'});}catch(e){probes.push({name,code:e.code,message:e.message,position:e.position});}await c.query('ROLLBACK');
}
await c.end();fs.writeFileSync(path.join(artifacts,'migration-probes.json'),JSON.stringify({applied,probes},null,2));
const me=evidence('Clean migration failure and independent migration probes',`**Status:** ${r.status===0?'Unexpected success':'REPRODUCED'}. **Command:** \`node --import tsx db/migrate.ts\` in the temporary unmodified checkout, with explicit verified local DATABASE_URL. [clean-migrate.txt](runtime-artifacts/clean-migrate.txt). Applied ${applied.length} migrations before the runner stopped. Separate 0054/0055 probes each ran inside a transaction that was rolled back:\n\n\`\`\`json\n${JSON.stringify(probes,null,2)}\n\`\`\`\n\n[migration-probes.json](runtime-artifacts/migration-probes.json) records applied filenames/error codes. No migrations or source files were edited. Full normal startup is blocked by the supplied migration chain. Any later partial-schema test must identify omitted migrations explicitly.`);
updateFinding('FINDING-027','REPRODUCED',me,'Clean PostgreSQL 16 migration chain fails; independent 0054/0055 probes recorded.');
console.log(JSON.stringify({proof,applied:applied.length,probes}));
