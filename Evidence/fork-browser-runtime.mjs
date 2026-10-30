// HTTP runtime proof. Browser rendering remains a separate verification step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const results=[];
for(const port of [5173,5174]) {
  const base=`http://127.0.0.1:${port}`;
  const root=await fetch(base+'/');assert.equal(root.status,200);
  const me=await fetch(base+(port===5173?'/v1/auth/me':'/v1/admin/auth/me'));
  assert.equal(me.status,401);assert.deepEqual(await me.json(),{error:'unauthenticated',message:'unauthenticated'});
  results.push({port,rootStatus:root.status,proxiedAuthStatus:me.status});
}
fs.writeFileSync('Evidence/fork-batch1-runtime.json',JSON.stringify({results,browser:'Unavailable: browser discovery returned []',scope:'Live Vite servers proxy /v1 to loopback API; actual rendering not verified'},null,2));
console.log(results);
