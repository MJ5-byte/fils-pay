// Disposable loopback-only PostgreSQL for fork-mining regression tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { Client } from 'pg';
const root = path.resolve('.fork-tooling');
fs.mkdirSync(root, { recursive: true });
const previous = JSON.parse(fs.readFileSync('Evidence/runtime-artifacts/session.json', 'utf8'));
const bin = previous.pgbin; // Reuse binaries only; never reuse the prior database.
const data = path.join(root, 'pgdata');
let port;
let pid;
if (fs.existsSync(data)) {
  const state = fs.readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/);
  if (path.resolve(state[1]) !== data) throw Error('Unexpected existing cluster');
  pid = Number(state[0]); port = Number(state[3]);
} else {
const init = spawnSync(path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'fork_local', '-A', 'trust', '--encoding=UTF8', '--locale=C'], { windowsHide: true, encoding: 'utf8' });
fs.writeFileSync(path.join(root, 'initdb.log'), init.stdout + init.stderr);
if (init.status !== 0) throw Error('initdb failed; see .fork-tooling/initdb.log');
port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
fs.writeFileSync(path.join(data, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n');
const log = fs.openSync(path.join(root, 'postgres.log'), 'a');
const child = spawn(path.join(bin, 'postgres.exe'), ['-D', data, '-h', '127.0.0.1', '-p', String(port)], { windowsHide: true, detached: true, stdio: ['ignore', log, log] });
child.unref(); fs.closeSync(log);
pid = child.pid;
}
const base = `postgres://fork_local@127.0.0.1:${port}`;
let client;
for (let i = 0; i < 40; i++) {
  const c = new Client({ connectionString: base + '/postgres', connectionTimeoutMillis: 500 });
  try { await c.connect(); client = c; break; } catch { await c.end().catch(() => {}); await new Promise(r => setTimeout(r, 250)); }
}
if (!client) throw Error('Local PostgreSQL failed to start');
const proof = (await client.query("SELECT current_setting('data_directory') data_directory, host(inet_server_addr()) address, inet_server_port() port, version()" )).rows[0];
console.log(JSON.stringify(proof));
if (path.resolve(proof.data_directory).toLowerCase() !== data.toLowerCase() || proof.address !== '127.0.0.1' || Number(proof.port) !== port) { await client.end(); throw Error('Isolation check failed'); }
await client.query('CREATE DATABASE fork_mining'); await client.end();
fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({ databaseUrl: base + '/fork_mining', pid, bin, data, proof }, null, 2));
console.log(JSON.stringify(proof));

