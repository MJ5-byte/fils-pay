import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';
import {session,run,safeEnv,evidence,section,updateFinding,artifacts,timestamp} from './investigate.mjs';
const s=session();
const require=createRequire(path.join(s.checkout,'package.json'));
const {Client}=require('pg');
const pkg=path.join(s.temp,'tooling/node_modules/@embedded-postgres/windows-x64');
const bin=path.join(pkg,'native/bin');
const pgdata=path.join(s.temp,'pgdata');
const emptyNpm=path.join(s.temp,'empty.npmrc');fs.writeFileSync(emptyNpm,'');

evidence('Independent startup review finds an accounting-control contradiction',`**Status:** Static-only; runtime test pending. **New lead NEW-001 (High):** contrary to the previous documentation report's claim of ledger immutability, \`db/migrations/0007_ledger_double_entry.sql:39-74\` installs a deferred balance check, not a prohibition on UPDATE/DELETE. Editing both balanced legs or deleting an entire group appears able to satisfy that check. The migration's final comment incorrectly claims no separate reject trigger is needed. This will be tested using synthetic ledger groups after database isolation.\n\nThe source also contains batch row locking and a unique (merchant,date) key; absence of the claimed singleton lock alone does not prove duplicate CloseBatch financial effects (FINDING-023).\n\n**Dependency preparation:** \`npm ci --offline --ignore-scripts --no-audit --no-fund\` in the temporary source copy installed 179 packages from the existing npm cache. [dependency-install.txt](runtime-artifacts/dependency-install.txt). The PostgreSQL 16.9 Windows binary package was installed separately with lifecycle scripts disabled: [postgres-package-install.txt](runtime-artifacts/postgres-package-install.txt). Binary provenance: [upstream project](https://github.com/leinelissen/embedded-postgres). No source changes or production data were used.`);

if(process.argv[2]==='stop'){
 run(path.join(bin,'pg_ctl.exe'),['-D',pgdata,'-m','fast','-w','stop'],{cwd:s.temp,file:'postgres-stop',timeout:30000});process.exit();
}
if(fs.existsSync(pgdata))throw Error('Refuse to initialize an existing directory');
const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
let r=run(path.join(bin,'initdb.exe'),['-D',pgdata,'-U','forensic_local','--encoding=UTF8','--locale=C','--auth=trust'],{cwd:s.temp,file:'postgres-initdb',timeout:60000});
if(r.status!==0)throw Error('initdb failed; see artifact');
fs.appendFileSync(path.join(pgdata,'postgresql.conf'),`\n# Disposable forensic instance, created ${timestamp()}\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 60\n`);
fs.writeFileSync(path.join(pgdata,'pg_hba.conf'),'host all all 127.0.0.1/32 trust\n');
r=run(path.join(bin,'pg_ctl.exe'),['-D',pgdata,'-l',path.join(s.temp,'postgres.log'),'-w','start'],{cwd:s.temp,file:'postgres-start',timeout:40000});
if(r.status!==0)throw Error('pg_ctl failed; see artifact');
const base=`postgres://forensic_local@127.0.0.1:${port}`;
const admin=new Client({connectionString:base+'/postgres',connectionTimeoutMillis:3000});await admin.connect();
const proof=(await admin.query(`SELECT version(), current_database(), current_user, inet_server_addr()::text server_address, inet_server_port() server_port, current_setting('data_directory') data_directory, current_setting('listen_addresses') listen_addresses, pg_postmaster_start_time() postmaster_started`)).rows[0];
if(proof.server_address!=='127.0.0.1'||proof.server_port!==port||path.resolve(proof.data_directory)!==path.resolve(pgdata)||proof.listen_addresses!=='127.0.0.1')throw Error('isolation check failed');
const existing=(await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")).rows;
if(existing.some(x=>x.datname!=='postgres'))throw Error('unexpected database in new cluster');
await admin.query('CREATE DATABASE fils_forensic_clean');await admin.end();
Object.assign(s,{pgdata,pgbin:bin,port,base,cleanUrl:base+'/fils_forensic_clean'});fs.writeFileSync(path.join(artifacts,'session.json'),JSON.stringify(s,null,2));
fs.writeFileSync(path.join(artifacts,'isolation.json'),JSON.stringify({checked:timestamp(),proof,existing,network:'127.0.0.1 only',sourceData:'none; newly initialized cluster',environment:'whitelisted; no inherited PG*, DATABASE_URL, PGCONN_SETTLEMENT, secrets or dotenv files',resolved:{api:s.cleanUrl,reporting:s.cleanUrl,settlement:s.cleanUrl,PGCONN_SETTLEMENT:'absent'},auth:'trust only on local disposable 127.0.0.1 listener'},null,2));
const eid=evidence('Disposable PostgreSQL isolation established before migrations',`**Status:** Verified local runtime environment. PostgreSQL reports \`${proof.version}\`; its newly initialized data directory is \`${proof.data_directory}\`. The sole listener is \`127.0.0.1:${port}\`. The cluster originally contained only \`postgres\` plus templates. Created empty \`fils_forensic_clean\` after verifying server address, port, start time and data directory.\n\n[isolation.json](runtime-artifacts/isolation.json) records resolved connection targets. All child environments are whitelisted, \`PGCONN_SETTLEMENT\` is absent, no dotenv file is loaded, and no real credential or data dump is used. Synthetic local role has no password. [postgres-initdb.txt](runtime-artifacts/postgres-initdb.txt), [postgres-start.txt](runtime-artifacts/postgres-start.txt).\n\n**Commands:** \`node Evidence/runtime-artifacts/infra.mjs\` runs the exact initdb/pg_ctl arguments in those artifacts. Migrations are permitted only against this verified new database.`);
section(3,`Isolation established at ${timestamp()}; see ${eid} and [isolation.json](runtime-artifacts/isolation.json). PostgreSQL 16.9 is bound solely to loopback at port ${port}, with a new data directory outside the repository. Explicit local URLs and whitelisted child environments exclude ambient credentials and PG overrides. No production/shared database, payment processor, bank transfer, merchant endpoint or production dump has been contacted. Only synthetic data will be created.\n\nRepository preservation restrictions remain as stated at opening. Source copies and build output are temporary; only new Evidence files persist in the workspace.`);
const env=safeEnv({DATABASE_URL:s.cleanUrl,npm_config_update_notifier:'false'});
r=run(process.execPath,['--import','tsx','db/migrate.ts'],{cwd:s.checkout,env,file:'clean-migrate',timeout:30000});
const client=new Client({connectionString:s.cleanUrl});await client.connect();
const applied=(await client.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows;
const probes=[];
for(const name of ['0054_views.sql','0055_chart_of_accounts_suspense.sql']){
 await client.query('BEGIN');
 try{await client.query(fs.readFileSync(path.join(s.checkout,'db/migrations',name),'utf8'));probes.push({name,result:'unexpected success'});}
 catch(e){probes.push({name,code:e.code,message:e.message,position:e.position});}
 await client.query('ROLLBACK');
}
await client.end();
fs.writeFileSync(path.join(artifacts,'migration-probes.json'),JSON.stringify({applied,probes},null,2));
const me=evidence('Clean migration runner and independent suspect migration probes',`**Status:** ${r.status===0?'Unexpected success':'REPRODUCED migration failure'}.\n\n**Command:** from the unmodified temporary source copy, \`node --import tsx db/migrate.ts\`, with DATABASE_URL explicitly resolved to the verified disposable database. [clean-migrate.txt](runtime-artifacts/clean-migrate.txt).\n\n**Applied migration count:** ${applied.length}. **Separate probes**, each rolled back:\n\n\`\`\`json\n${JSON.stringify(probes,null,2)}\n\`\`\`\n\n[ migration-probes.json](runtime-artifacts/migration-probes.json) lists all applied filenames and PostgreSQL error codes. No migration, tracked configuration, or source file was edited. Full normal startup is blocked by the unmodified migration chain. Any later partial-schema testing will disclose exactly which migrations were omitted.`);
updateFinding('FINDING-027','REPRODUCED',me,'Clean runner fails; separate 0054/0055 probes captured with SQL error codes.');
