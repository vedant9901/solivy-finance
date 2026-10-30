/**
 * Online (Vercel + Neon) network-transfer benchmark.
 *   node --require ./tests/setup/register.cjs --import tsx tests/bench/bridge-bench.ts <out.json>
 * Requires a reachable PostgreSQL in BENCH_PG_URL (default local test cluster).
 * Phase 1 (child, local mode): seed 3 organizations through the real API.
 * Phase 2: upload the SQLite files as bridge snapshots into a fresh PG database.
 * Phase 3 (child, VERCEL=1): run scenarios and record PG socket bytes per request.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const PG = process.env.BENCH_PG_URL || 'postgres://postgres@127.0.0.1:54329';
const ORGS = Number(process.env.BENCH_ORGS || 3);
const PURCHASES = Number(process.env.BENCH_PURCHASES || 600);
const phase = process.argv[2];

function nodeArgs(script: string, extra: string[]) {
  return ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', script, ...extra];
}

async function seed(dir: string) {
  const { call, seedOrg, seedUser, login, expectOk } = await import('../helpers/app');
  const ids: number[] = [];
  for (let i = 0; i < ORGS; i++) ids.push(await seedOrg({ companyName: `Bench Org ${i + 1}`, code: `BENCH${i + 1}` }));
  await seedUser({ username: 'benchadmin', role: 'ADMIN', companies: ids.map((id) => ({ id, live: true, test: true })) });
  for (const id of ids) {
    const cookie = await login('benchadmin', id, 'LIVE');
    expectOk(await call('/api/accounts', { cookie, body: { account_name: 'Main Bank', bank_name: 'HDFC', account_type: 'BANK', opening_balance: 50_000_000, opening_date: '2026-04-01' } }));
    for (let p = 0; p < 40; p++) expectOk(await call('/api/parties', { cookie, body: { name: `Vendor ${p}`, party_type: 'GOODS_VENDOR', address: 'Plot 12, APMC Yard, Unjha, Gujarat', contact: '98250' + String(10000 + p), gst: '24ABCDE' + String(1000 + p) + 'F1Z5' } }));
    const data = expectOk(await call('/api/data', { cookie }));
    const acct = data.accounts[0].id;
    const parties = data.parties.map((x: any) => x.id);
    for (let k = 0; k < PURCHASES; k++) {
      const day = String(1 + (k % 28)).padStart(2, '0'); const month = String(4 + (k % 6)).padStart(2, '0');
      expectOk(await call('/api/purchases', { cookie, body: { party_id: parties[k % parties.length], purchase_date: `2026-${month}-${day}`, net_weight: 9000 + k, gross_weight: 9100 + k, rate: 52 + (k % 7), freight: 1500, unload_charge: 400, discount_pct: 1, goods_description: 'Cumin seed (jeera) — machine clean', truck_number: `GJ02AB${1000 + k}`, invoice_no: `INV-${k}` } }));
      if (k % 3 === 0) expectOk(await call('/api/payments', { cookie, body: { party_id: parties[k % parties.length], payment_date: `2026-${month}-${day}`, amount: 200000, mode: 'BANK', company_account_id: acct } }));
    }
  }
  fs.writeFileSync(path.join(dir, 'ids.json'), JSON.stringify(ids));
}

async function upload(dir: string, dbName: string) {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: `${PG}/postgres` }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.query(`CREATE DATABASE ${dbName}`); await admin.end();
  const c = new Client({ connectionString: `${PG}/${dbName}` }); await c.connect();
  await c.query('CREATE TABLE IF NOT EXISTS solivy_sqlite_snapshots (db_key TEXT PRIMARY KEY, db_file BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const ids: number[] = JSON.parse(fs.readFileSync(path.join(dir, 'ids.json'), 'utf8'));
  const Database = require('better-sqlite3');
  const files: Array<[string, string]> = [['admin', path.join(dir, 'admin.db')]];
  for (const id of ids) for (const m of ['LIVE', 'TEST']) files.push([`company:${id}:${m}`, id === 1 ? path.join(dir, m === 'LIVE' ? 'live.db' : 'test.db') : path.join(dir, 'companies', String(id), m === 'LIVE' ? 'live.db' : 'test.db')]);
  let total = 0; const sizes: Record<string, number> = {};
  for (const [key, file] of files) {
    if (!fs.existsSync(file)) continue;
    const d = new Database(file); d.pragma('wal_checkpoint(TRUNCATE)'); d.close();
    const bytes = fs.readFileSync(file); total += bytes.length; sizes[key] = bytes.length;
    await c.query('INSERT INTO solivy_sqlite_snapshots(db_key,db_file) VALUES($1,$2) ON CONFLICT(db_key) DO UPDATE SET db_file=EXCLUDED.db_file', [key, bytes]);
  }
  await c.end();
  return { total, sizes };
}

async function measure(out: string) {
  const { call } = await import('../helpers/app');
  const bytes = (globalThis as any).__pgBytes as () => { read: number; written: number };
  const ids: number[] = JSON.parse(process.env.BENCH_IDS || '[1]');
  const results: any[] = [];
  async function scenario(name: string, fn: () => Promise<any>) {
    const before = bytes(); const t = performance.now();
    const r = await fn();
    const after = bytes();
    results.push({ name, status: r?.status, ms: Math.round(performance.now() - t), pg_read: after.read - before.read, pg_written: after.written - before.written, response_bytes: r?.bytes ?? 0, error: r?.status >= 400 ? String(r?.text || '').slice(0, 300) : undefined });
    return r;
  }
  let pass = '';
  const runPass = async (label: string) => {
    pass = label;
    await scenario(pass + ' | ' + 'POST /api/login (wrong password, unauthenticated)', () => call('/api/login', { body: { username: 'benchadmin', password: 'nope', company_id: ids[0], mode: 'LIVE' } }));
    const login = await scenario(pass + ' | ' + 'POST /api/login (valid)', () => call('/api/login', { body: { username: 'benchadmin', password: 'Correct-Horse-9', company_id: ids[0], mode: 'LIVE' } }));
    const cookie = login.cookie;
    await scenario(pass + ' | ' + 'POST /api/sync/exchange (invalid device token, unauthenticated)', () => call('/api/sync/exchange', { body: { events: [] }, headers: { 'x-aksh-company-id': String(ids[0]), 'x-aksh-mode': 'LIVE', 'x-solivy-device-token': 'bad', 'x-solivy-device-id': 'dev' } }));
    await scenario(pass + ' | ' + 'GET /api/data (dashboard initial load)', () => call('/api/data', { cookie }));
    await scenario(pass + ' | ' + 'GET /api/data (repeat, unchanged)', () => call('/api/data', { cookie }));
    if (fs.readFileSync(path.join(ROOT, 'app/api/data/route.ts'), 'utf8').includes('modules')) {
      await scenario(pass + ' | ' + 'GET /api/data?modules=<dashboard tab> (v2.7 client)', () => call('/api/data', { cookie, query: { modules: 'core,parties,accounts,money,payments,purchases,receivables' } }));
      await scenario(pass + ' | ' + 'GET /api/data?modules=<parties tab> (v2.7 client)', () => call('/api/data', { cookie, query: { modules: 'core,parties,accounts' } }));
    }
    await scenario(pass + ' | ' + 'GET /api/accounts', () => call('/api/accounts', { cookie }));
    if (fs.existsSync(path.join(ROOT, 'app/api/bootstrap/route.ts'))) await scenario(pass + ' | ' + 'GET /api/bootstrap (new slim initial load)', () => call('/api/bootstrap', { cookie }));
    if (fs.existsSync(path.join(ROOT, 'app/api/purchases/route.ts'))) await scenario(pass + ' | ' + 'GET /api/purchases?limit=50 (paged module)', () => call('/api/purchases', { cookie, query: { limit: 50 } }));
    await scenario(pass + ' | ' + 'GET /api/secondary-backup (5-min admin poll)', () => call('/api/secondary-backup', { cookie }));
    await scenario(pass + ' | ' + 'POST /api/parties (single write)', () => call('/api/parties', { cookie, body: { name: 'Bench New Vendor', party_type: 'GOODS_VENDOR' } }));
  };
  await runPass('1 cold (first request after upgrade)');
  await runPass('2 steady (warm instance)');
  (globalThis as any).__solivyBridgeCache?.clear?.();
  const dataDir = process.env.FINANCE_DATA_DIR!;
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { recursive: true, force: true });
  await runPass('3 fresh instance (no local cache)');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
}

(async () => {
  if (phase === '--seed') return seed(process.env.FINANCE_DATA_DIR!);
  if (phase === '--measure') return measure(process.argv[3]);
  const out = path.resolve(phase || 'bench.json');
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-bench-seed-'));
  const dbName = `bench_${Date.now()}`;
  const env = { ...process.env, FINANCE_DATA_DIR: seedDir } as any; delete env.VERCEL;
  execFileSync(process.execPath, nodeArgs(__filename, ['--seed']), { env, stdio: 'inherit', cwd: ROOT });
  const up = await upload(seedDir, dbName);
  const ids = fs.readFileSync(path.join(seedDir, 'ids.json'), 'utf8');
  const mEnv = { ...process.env, VERCEL: '1', DATABASE_URL: `${PG}/${dbName}`, FINANCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-bench-run-')), BENCH_IDS: ids, SOLIVY_PG_SSL: 'disable' } as any;
  const tmp = out + '.scenarios.json';
  execFileSync(process.execPath, ['--require', path.join(__dirname, 'pg-instrument.cjs'), ...nodeArgs(__filename, ['--measure', tmp])], { env: mEnv, stdio: 'inherit', cwd: ROOT });
  const report = { generated_at: new Date().toISOString(), orgs: ORGS, purchases_per_org: PURCHASES, snapshot_bytes_total: up.total, snapshot_sizes: up.sizes, scenarios: JSON.parse(fs.readFileSync(tmp, 'utf8')) };
  fs.writeFileSync(out, JSON.stringify(report, null, 2)); fs.unlinkSync(tmp);
  console.table(report.scenarios.map((s: any) => ({ scenario: s.name, status: s.status, ms: s.ms, pg_read_KB: +(s.pg_read / 1024).toFixed(1), pg_written_KB: +(s.pg_written / 1024).toFixed(1), resp_KB: +(s.response_bytes / 1024).toFixed(1) })));
  console.log('snapshot total KB', (up.total / 1024).toFixed(1));
})().catch((e) => { console.error(e); process.exit(1); });
