import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
import {session,artifacts,evidence,run,safeEnv,section} from './investigate.mjs';
const s=session();const {Client}=createRequire(path.join(s.checkout,'package.json'))('pg');
const a=new Client({connectionString:s.base+'/postgres'});await a.connect();
await a.query('CREATE DATABASE fils_forensic_partial');await a.end();
s.partialUrl=s.base+'/fils_forensic_partial';fs.writeFileSync(path.join(artifacts,'session.json'),JSON.stringify(s,null,2));
const c=new Client({connectionString:s.partialUrl});await c.connect();
await c.query('CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
const results=[];
for(const name of fs.readdirSync(path.join(s.checkout,'db/migrations')).filter(x=>x.endsWith('.sql')).sort()){
 await c.query('BEGIN');try{
  await c.query(fs.readFileSync(path.join(s.checkout,'db/migrations',name),'utf8'));
  await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[name]);await c.query('COMMIT');results.push({name,status:'applied'});
 }catch(e){await c.query('ROLLBACK');results.push({name,status:'failed/omitted',code:e.code,message:e.message});}
}
await c.end();fs.writeFileSync(path.join(artifacts,'partial-schema.json'),JSON.stringify(results,null,2));
const omitted=results.filter(r=>r.status!=='applied');
const eid=evidence('Explicit partial-schema fixture permits independent subsystem testing',`**Status:** Temporary test setup, NOT successful full migration or deployment. A second new database \`fils_forensic_partial\` was created inside the verified loopback cluster. Each original SQL migration ran byte-for-byte in its own transaction; failed migrations were rolled back and omitted, then testing continued to independent later migrations.\n\n**Omissions:**\n\n\`\`\`json\n${JSON.stringify(omitted,null,2)}\n\`\`\`\n\nApplied ${results.length-omitted.length}/${results.length} migrations. [partial-schema.json](runtime-artifacts/partial-schema.json). No migration source was modified, no missing table was fabricated, and no real data was imported. All tests below explicitly use this partial-schema fixture unless stated otherwise. This cannot demonstrate full-system readiness.\n\n**Command:** \`node Evidence/runtime-artifacts/partial-db.mjs\`.`);
section(4,`The normal stack has NOT started successfully. Docker is absent and both referenced Dockerfiles are missing. Dependencies installed in the temporary checkout; PostgreSQL 16.9 runs only on loopback. The unmodified migration runner fails at 0054 (${eid.replace(/\d+$/,'006')}; [clean-migrate.txt](runtime-artifacts/clean-migrate.txt)).\n\nAn explicitly separate partial-schema database was prepared for independent service tests (${eid}). Failed migrations are recorded in [partial-schema.json](runtime-artifacts/partial-schema.json). Service boot/build results will be added next. This fixture does not repair or validate the normal startup path.`);
console.log(JSON.stringify({applied:results.length-omitted.length,omitted}));
