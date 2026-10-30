import fs from 'node:fs';import path from 'node:path';
import {session,run,safeEnv,evidence,artifacts} from './investigate.mjs';
const s=session();const mode=process.argv[2];
const env=safeEnv({DATABASE_URL:s.partialUrl||s.cleanUrl,WEBHOOK_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),KYC_UPLOAD_DIR:path.join(s.temp,'kyc'),GOCACHE:path.join(s.temp,'go-build'),GOPATH:path.join(s.temp,'go'),GOENV:'off',GOTOOLCHAIN:'local',npm_config_update_notifier:'false'});
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
if(mode==='typecheck'){
 const r=run(process.execPath,[npm,'run','typecheck'],{cwd:s.checkout,env,file:'typecheck',timeout:180000});
 evidence('Unmodified TypeScript typecheck',`**Status:** ${r.status===0?'Passed':'Failed'}. **Command:** \`npm run typecheck\` in the temporary source copy. [typecheck.txt](runtime-artifacts/typecheck.txt). No emit, source edits or fixers. Exact diagnostics retained; failure is not treated as proof of exploitability.`);
}else if(mode==='go'){
 const r=run('C:/Program Files/Go/bin/go.exe',['test','-count=1','-json','./...'],{cwd:path.join(s.checkout,'apps/settlement'),env,file:'go-original-tests',timeout:180000});
 evidence('Original Go suite on isolated partial schema',`**Status:** ${r.status===0?'Passed':'Failed or incomplete'}. **Command:** \`go test -count=1 -json ./...\`, isolated local DATABASE_URL, separate temporary module/build caches. [go-original-tests.txt](runtime-artifacts/go-original-tests.txt). No existing tests changed. Per-test skips/failures must be counted from the artifact; a package-level pass alone does not prove all tests ran. The DB fixture omits failed migrations listed in partial-schema.json.`);
}else if(mode==='ts'){
 const r=run(process.execPath,[npm,'test'],{cwd:s.checkout,env,file:'ts-original-tests',timeout:180000});
 evidence('Original TypeScript suite on isolated partial schema',`**Status:** ${r.status===0?'Passed':'Failed or incomplete'}. **Command:** \`npm test\` in temporary checkout with explicit local DATABASE_URL, synthetic webhook key, and KYC output redirected outside the repository. [ts-original-tests.txt](runtime-artifacts/ts-original-tests.txt). Existing tests are unmodified. Partial schema limitations are recorded separately; failures are retained without repair.`);
}else if(mode==='builds'){
 const results=[];
 for(const app of ['web','admin']){
  const r=run(process.execPath,[path.join(s.checkout,'node_modules/vite/bin/vite.js'),'build','--outDir',path.join(s.temp,app+'-dist'),'--emptyOutDir'],{cwd:path.join(s.checkout,'apps',app),env,file:app+'-build',timeout:60000});results.push({app,exit:r.status});
 }
 const r=run('C:/Program Files/Go/bin/go.exe',['build','-o',path.join(s.temp,'settlement.exe'),'./cmd/settlement'],{cwd:path.join(s.checkout,'apps/settlement'),env,file:'settlement-build',timeout:120000});results.push({app:'settlement',exit:r.status});
 evidence('Frontend and settlement production builds',`**Status:** Recorded independently of full startup. **Commands:** \`vite build --outDir <temporary-output> --emptyOutDir\` for web/admin and \`go build -o <temporary-settlement.exe> ./cmd/settlement\`. Temporary output directories were explicitly named under this investigation's temp directory; no project output directories were cleaned. Results: \`${JSON.stringify(results)}\`. [web-build.txt](runtime-artifacts/web-build.txt), [admin-build.txt](runtime-artifacts/admin-build.txt), [settlement-build.txt](runtime-artifacts/settlement-build.txt).`);
}else throw Error('unknown mode');
