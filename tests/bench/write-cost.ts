/**
 * Where the snapshot upload of a single posting goes: per-request chunk counts and bytes, with the
 * tables whose pages changed. Online mode only.
 *   SOLIVY_TEST_PG_URL=... node --require ./tests/setup/register.cjs --import tsx tests/bench/write-cost.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PG = process.env.SOLIVY_TEST_PG_URL || 'postgres://postgres@127.0.0.1:54329';
const DB = `writecost_${Date.now()}`;

(async () => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: `${PG}/postgres` }); await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.VERCEL = '1'; process.env.DATABASE_URL = `${PG}/${DB}`; process.env.SOLIVY_PG_SSL = 'disable';
  process.env.SOLIVY_SETUP_SECRET = 'write-cost-secret-0123456789';
  process.env.FINANCE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-wc-'));
  const app = await import('../helpers/app');
  const { transferStats } = await import('../../lib/snapshot-store');
  app.expectOk(await app.call('/api/setup', { body: { setupSecret: process.env.SOLIVY_SETUP_SECRET, username: 'owner', name: 'Owner', email: 'o@example.test', password: 'Correct-Horse-Battery-9', confirmPassword: 'Correct-Horse-Battery-9' } }));
  const cookie = await app.login('owner', 1, 'LIVE', 'Correct-Horse-Battery-9');
  const { seedFinance } = await import('../helpers/seed-finance');
  await seedFinance(cookie);

  const show = (label: string) => console.log(`${label.padEnd(46)} up ${(transferStats.bytesUp / 1024).toFixed(1).padStart(7)} KB in ${String(transferStats.chunksUp).padStart(4)} chunks | down ${(transferStats.bytesDown / 1024).toFixed(1).padStart(7)} KB in ${String(transferStats.chunksDown).padStart(4)} chunks${transferStats.baseDownloads ? ' (base blob)' : ''}`);
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Cost A', party_type: 'GOODS_VENDOR' } })); show('write 1 (after seeding + first trim)');
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Cost B', party_type: 'GOODS_VENDOR' } })); show('write 2');
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Cost C', party_type: 'GOODS_VENDOR' } })); show('write 3');
  app.expectOk(await app.call('/api/data', { cookie, query: { modules: 'core,parties' } })); show('read (warm instance)');
  app.expectOk(await app.call('/api/purchases', { cookie, body: { party_id: 1, purchase_date: '2026-07-01', net_weight: 9000, gross_weight: 9100, rate: 52, freight: 1000, goods_description: 'Cumin', truck_number: 'GJ01AA1111' } })); show('purchase posting');
  (globalThis as any).__solivyBridgeCache?.clear?.();
  for (const f of fs.readdirSync(process.env.FINANCE_DATA_DIR!)) fs.rmSync(path.join(process.env.FINANCE_DATA_DIR!, f), { recursive: true, force: true });
  app.expectOk(await app.call('/api/data', { cookie, query: { modules: 'core,parties' } })); show('read (cold instance)');
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Cost D', party_type: 'GOODS_VENDOR' } })); show('write (cold instance)');
  const c = new Client({ connectionString: `${PG}/${DB}` }); await c.connect();
  const r = await c.query("SELECT db_key, size_bytes, chunk_size, octet_length(db_file) base, (SELECT COALESCE(SUM(octet_length(data)),0) FROM solivy_sqlite_chunks ch WHERE ch.db_key=s.db_key) stored FROM solivy_sqlite_snapshots s ORDER BY db_key");
  for (const row of r.rows) console.log(`${row.db_key.padEnd(20)} file ${(row.size_bytes / 1024).toFixed(0)} KB, chunk ${row.chunk_size}B, chunks stored ${(row.stored / 1024).toFixed(0)} KB, base blob ${(row.base / 1024).toFixed(0)} KB`);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
