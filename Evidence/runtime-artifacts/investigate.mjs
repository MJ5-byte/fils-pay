import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export const artifacts=path.dirname(fileURLToPath(import.meta.url));
export const root=path.resolve(artifacts,'../..');
export const report=path.join(root,'Evidence/FilsPay_Runtime_Security_Investigation.md');
export const timestamp=()=>new Date().toLocaleString('sv-SE',{timeZone:'Asia/Bahrain'})+' +03:00';
export const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export function section(n,body){
 const s=fs.readFileSync(report,'utf8');
 const re=new RegExp(`(## ${n}\\. [^\\n]+\\n)[\\s\\S]*?(?=\\n## |$)`);
 if(!re.test(s))throw Error('missing section '+n);
 fs.writeFileSync(report,s.replace(re,(_,heading)=>heading+'\n'+body.trim()+'\n'),'utf8');
}
export function evidence(title,body){
 const s=fs.readFileSync(report,'utf8');
 const ids=[...s.matchAll(/### EVID-(\d+)/g)].map(m=>+m[1]);
 const id='EVID-'+String(Math.max(0,...ids)+1).padStart(3,'0');
 const entry=`\n### ${id} — ${title}\n\n**Timestamp:** ${timestamp()}.\n\n${body.trim()}\n`;
 fs.writeFileSync(report,s.replace(/\n## 6\./,entry+'\n## 6.'),'utf8');
 console.log(id+': '+title);return id;
}
export function session(){return JSON.parse(fs.readFileSync(path.join(artifacts,'session.json'),'utf8'));}
export function updateFinding(id,status,evid,notes,severity){
 const p=path.join(artifacts,'findings.json');const rows=JSON.parse(fs.readFileSync(p,'utf8'));
 const f=rows.find(f=>f.id===id);if(!f)throw Error('unknown finding '+id);
 Object.assign(f,{status,evidence:evid,notes});if(severity)f.severity=severity;
 fs.writeFileSync(p,JSON.stringify(rows,null,2));
 section(6,'| Original ID | Issue | Severity | Verification Status | Evidence ID | Notes |\n|---|---|---|---|---|---|\n'+rows.map(f=>`| ${f.id} | ${f.title.replaceAll('|','/')} | ${f.severity} | ${f.status} | ${f.evidence} | ${f.notes.replaceAll('|','/')} |`).join('\n'));
}
export function safeEnv(extra={}){
 const keep=['SystemRoot','SYSTEMROOT','windir','WINDIR','ComSpec','COMSPEC','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMFILES','ProgramFiles','ProgramFiles(x86)','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'];
 const env=Object.fromEntries(keep.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 return {...env,NODE_ENV:'test',...extra};
}
export function run(exe,args,{cwd=root,env=safeEnv(),file='command',timeout=120000}={}){
 const baseFile=file;let suffix=1;while(fs.existsSync(path.join(artifacts,file+'.txt')))file=baseFile+'-'+(++suffix);
 const command=[exe,...args].map(x=>JSON.stringify(x)).join(' ');
 const start=timestamp(); const r=spawnSync(exe,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:32*1024*1024,windowsHide:true});
 let output=(r.stdout||'')+(r.stderr||'');
 // Only synthetic URLs should be present, but prevent incidental credentials in diagnostics.
 output=output.replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]+)?@/g,'$1[REDACTED]@');
 output=output.replace(/("(?:code|devOtpCode|rawToken|rawKey|secret|token_hash|code_hash|code_salt)"\s*:\s*")[^"]*(")/g,'$1[REDACTED]$2');
 const text=`Started: ${start}\nFinished: ${timestamp()}\nCWD: ${cwd}\nCommand: ${command}\nExit: ${r.status}\nSignal: ${r.signal}\nError: ${r.error?.message||''}\n\n${output}`;
 fs.writeFileSync(path.join(artifacts,file+'.txt'),text,'utf8');
 console.log(JSON.stringify({file,exit:r.status,error:r.error?.message,tail:output.slice(-3500)}));
 return {...r,output};
}

if(process.argv[2]==='init'){
 if(fs.existsSync(path.join(artifacts,'session.json')))throw Error('already initialized');
 const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.split('\0').filter(Boolean);
 const prior=['Evidence/DOCS_FULL_INVESTIGATION.md',...tracked.filter(p=>p.startsWith('Evidence/'))];
 const manifest=[...new Set([...tracked,...prior])].map(p=>({path:p,bytes:fs.statSync(path.join(root,p)).size,sha256:sha(fs.readFileSync(path.join(root,p)))}));
 fs.writeFileSync(path.join(artifacts,'baseline-manifest.json'),JSON.stringify(manifest,null,2));
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'filspay-forensic-'));
 const checkout=path.join(temp,'checkout');fs.mkdirSync(checkout);
 const omitted=[];
 for(const p of tracked){
  if(p.startsWith('Evidence/')||p.startsWith('docs/')||p==='db/seed/fixtures/production_seed.sql'||/(^|\/)\.env/.test(p)){omitted.push(p);continue;}
  const dest=path.join(checkout,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,p),dest);
 }
 fs.writeFileSync(path.join(artifacts,'session.json'),JSON.stringify({opened:timestamp(),temp,checkout,omitted},null,2));
 const priorText=fs.readFileSync(path.join(root,'Evidence/DOCS_FULL_INVESTIGATION.md'),'utf8');
 const findings=[...priorText.matchAll(/^### (FINDING-\d+) — (.*)\r?\n([\s\S]*?)(?=^### |^---|$)/gm)].map(m=>({id:m[1],title:m[2].trim(),original:m[3].trim(),severity:m[3].match(/Severity:\*\* ([^·\n]+)/)?.[1]?.trim()||'Pending',status:'NOT TESTED',evidence:'—',notes:'Independent verification pending.'}));
 if(findings.length!==32)throw Error('expected 32 got '+findings.length);
 fs.writeFileSync(path.join(artifacts,'findings.json'),JSON.stringify(findings,null,2));
 section(6,'| Original ID | Issue | Severity | Verification Status | Evidence ID | Notes |\n|---|---|---|---|---|---|\n'+findings.map(f=>`| ${f.id} | ${f.title.replaceAll('|','/')} | ${f.severity} | ${f.status} | ${f.evidence} | ${f.notes} |`).join('\n'));
 const all=fs.readFileSync(path.join(root,'Evidence/allcommits'),'utf8').split(/\r?\n/).filter(l=>l.startsWith('fils-pay\\'));
 const dossier=fs.readFileSync(path.join(root,'Evidence/FilsPay_Git_Commit_and_Code_Comments_Evidence.md'),'utf8');
 const missing=all.filter(l=>!dossier.includes(l.slice(l.indexOf('://')+1).trim()));
 fs.writeFileSync(path.join(artifacts,'prior-inventory-check.json'),JSON.stringify({sourceCommentRecords:all.length,notVerbatimInDossier:missing,priorEvidence:manifest.filter(x=>prior.includes(x.path))},null,2));
 evidence('Prior reports read; original IDs preserved; safe runtime copy prepared',`**Status:** Observed / static-only. Read the complete prior documentation report, Git/comment dossier (including comment inventory), forensic story, messages, archived instruction files, and commit inventory. The latter's source-comment appendix duplicates the dossier; automated comparison is in [prior-inventory-check.json](runtime-artifacts/prior-inventory-check.json).\n\nAll 32 original findings were extracted without renumbering into section 6 and [findings.json](runtime-artifacts/findings.json). Prior reports make static and snapshot claims, not runtime verification. The documentation report cites HEAD \`6d7cfb6\`; this investigation is pinned to the different current HEAD stated above.\n\n[baseline-manifest.json](runtime-artifacts/baseline-manifest.json) records SHA-256 and byte sizes of all tracked files and the pre-existing untracked report. A temporary source copy was prepared at \`${checkout}\`; source bytes were copied without edits. Committed environment files, the purported production SQL dump, all docs/exports, and prior Evidence were excluded. No application, test, migration or seed was executed by this preparation. Dependency/build/runtime output will remain in the temporary directory.\n\n**Initial static observations:** \`ops/Dockerfile.node\` and \`ops/Dockerfile.go\` are absent. \`apps/settlement/internal/config/config.go:72-74\` makes \`PGCONN_SETTLEMENT\` override \`DATABASE_URL\`. API, reporting, seeds and scripts use explicit \`DATABASE_URL\`; pg connection defaults may also be inherited if not cleared, so runtime child processes receive a whitelist of environment variables. No live connection target or secret values were printed or retained.\n\n**Command:** \`node Evidence/runtime-artifacts/investigate.mjs init\`.`);
 console.log(JSON.stringify({temp,checkout,tracked:tracked.length,findings:findings.length,sourceComments:all.length,missing:missing.length}));
}
