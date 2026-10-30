/** Two independent processes (= two serverless instances) writing the same organization. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PG = process.env.SOLIVY_TEST_PG_URL || '';
const SKIP = PG ? false : 'NOT VERIFIED: SOLIVY_TEST_PG_URL not set (no PostgreSQL available)';
const DB = `solivy_multi_${process.pid}_${Date.now()}`;
const ROOT = path.resolve(__dirname, '..', '..');
const SECRET = 'online-test-setup-secret-0123456789';

function envFor() {
  return { ...process.env, VERCEL: '1', DATABASE_URL: `${PG}/${DB}`, SOLIVY_PG_SSL: 'disable', SOLIVY_SETUP_SECRET: SECRET, FINANCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-inst-')) };
}
function run(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', script, ...args], { env: envFor(), cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

before(async () => {
  if (SKIP) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`CREATE DATABASE ${DB}`); await c.end();
  const setupScript = path.join(ROOT, 'tests/online/setup-worker.ts');
  fs.writeFileSync(setupScript, `import { call } from '../helpers/app';\n(async()=>{const r=await call('/api/setup',{body:{setupSecret:'${SECRET}',username:'owner',name:'Owner',email:'o@example.test',password:'Correct-Horse-Battery-9',confirmPassword:'Correct-Horse-Battery-9'}});if(r.status!==200)throw new Error(r.text);const {postgresPool}=await import('../../lib/postgres');await postgresPool().end();})();\n`);
  try { await run(setupScript, []); } finally { fs.unlinkSync(setupScript); }
});
after(async () => {
  if (SKIP) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await c.end();
});

test('two instances writing the same organization concurrently lose no updates', { skip: SKIP }, async () => {
  const worker = path.join(ROOT, 'tests/online/worker.ts');
  const [a, b] = await Promise.all([run(worker, ['12', 'A']), run(worker, ['12', 'B'])]);
  const statuses = [...JSON.parse(a), ...JSON.parse(b)];
  assert.deepEqual(statuses, Array(24).fill(200));
  // Read back through a third, fresh instance.
  const check = path.join(ROOT, 'tests/online/check-worker.ts');
  fs.writeFileSync(check, `import { call, login } from '../helpers/app';\n(async()=>{const c=await login('owner',1,'LIVE','Correct-Horse-Battery-9');const d=(await call('/api/data',{cookie:c})).json;process.stdout.write(JSON.stringify(d.parties.map((p:any)=>p.name)));const {postgresPool}=await import('../../lib/postgres');await postgresPool().end();})();\n`);
  try {
    const names: string[] = JSON.parse(await run(check, []));
    for (const t of ['A', 'B']) for (let i = 0; i < 12; i++) assert.ok(names.includes(`${t}-${i}`), `missing ${t}-${i}`);
  } finally { fs.unlinkSync(check); }
});
