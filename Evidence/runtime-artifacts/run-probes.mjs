import path from 'node:path';import {pathToFileURL} from 'node:url';import {session,run,safeEnv,artifacts,evidence} from './investigate.mjs';
const s=session();const file=process.argv[2];if(!/^[a-z0-9_-]+\.mjs$/.test(file||''))throw Error('invalid probe filename');
const r=run(process.execPath,['--import',pathToFileURL(path.join(s.checkout,'node_modules/tsx/dist/loader.mjs')).href,path.join(artifacts,file)],{cwd:s.checkout,env:safeEnv({DATABASE_URL:s.partialUrl,KYC_UPLOAD_DIR:path.join(s.temp,'probe-kyc')}),file:file.replace('.mjs','')+'-console',timeout:180000});
if(r.status!==0)evidence('Probe runner failed: '+file,`**Status:** Failed attempt, no vulnerability inferred. Run \`node Evidence/runtime-artifacts/run-probes.mjs ${file}\`; see corresponding numbered \`${file.replace('.mjs','')}-console*.txt\` artifact. Earlier attempts are preserved rather than overwritten. Error: ${r.error?.message||'see captured console'}.`);
process.exitCode=r.status??1;
