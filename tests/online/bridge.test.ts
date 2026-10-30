/**
 * ONLINE MODE (Vercel + Neon semantics) against a real PostgreSQL server.
 * Requires SOLIVY_TEST_PG_URL (e.g. postgres://postgres@127.0.0.1:54329). Without it every
 * test is reported as SKIPPED with the reason — never as passed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PG = process.env.SOLIVY_TEST_PG_URL || '';
const SKIP = PG ? false : 'NOT VERIFIED: SOLIVY_TEST_PG_URL not set (no PostgreSQL available)';
const DB = `solivy_online_${process.pid}_${Date.now()}`;
const SETUP_SECRET = 'online-test-setup-secret-0123456789';

let pg: any; let app: typeof import('../helpers/app');
let cookie = '';

async function sql(text: string, values: any[] = []) { return pg.query(text, values); }
function freshInstance() {
  (globalThis as any).__solivyBridgeCache?.clear();
  const dir = process.env.FINANCE_DATA_DIR!;
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}

before(async () => {
  if (SKIP) return;
  const { Client } = require('pg');
  const admin = new Client({ connectionString: `${PG}/postgres` }); await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.VERCEL = '1';
  process.env.DATABASE_URL = `${PG}/${DB}`;
  process.env.SOLIVY_PG_SSL = 'disable';
  process.env.SOLIVY_SETUP_SECRET = SETUP_SECRET;
  pg = new Client({ connectionString: `${PG}/${DB}` }); await pg.connect();
  app = await import('../helpers/app');
  const setup = await app.call('/api/setup', { body: { setupSecret: SETUP_SECRET, username: 'owner', name: 'Owner', email: 'owner@example.test', password: 'Correct-Horse-Battery-9', confirmPassword: 'Correct-Horse-Battery-9' } });
  assert.equal(setup.status, 200, setup.text);
  cookie = await app.login('owner', 1, 'LIVE', 'Correct-Horse-Battery-9');
});

after(async () => {
  if (SKIP) return;
  await pg?.end();
  const { postgresPool } = await import('../../lib/postgres');
  await postgresPool().end().catch(() => {});
  const { Client } = require('pg');
  const admin = new Client({ connectionString: `${PG}/postgres` }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.end();
});

test('writes persist to PostgreSQL and survive a fresh instance (no local cache)', { skip: SKIP }, async () => {
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Online Vendor', party_type: 'GOODS_VENDOR' } }));
  const rows = (await sql("SELECT db_key, format, version FROM solivy_sqlite_snapshots ORDER BY db_key")).rows;
  assert.ok(rows.some((r: any) => r.db_key === 'company:1:LIVE' && Number(r.format) === 2));
  freshInstance();
  const data = app.expectOk(await app.call('/api/data', { cookie }));
  assert.ok(data.parties.some((p: any) => p.name === 'Online Vendor'));
});

test('read-only requests never write snapshots', { skip: SKIP }, async () => {
  const before = (await sql('SELECT db_key, version FROM solivy_sqlite_snapshots ORDER BY db_key')).rows;
  for (let i = 0; i < 3; i++) app.expectOk(await app.call('/api/data', { cookie }));
  freshInstance();
  app.expectOk(await app.call('/api/accounts', { cookie }));
  const afterRows = (await sql('SELECT db_key, version FROM solivy_sqlite_snapshots ORDER BY db_key')).rows;
  assert.deepEqual(afterRows, before);
});

test('unauthenticated login attempt loads admin.db only (no organization data)', { skip: SKIP }, async () => {
  freshInstance();
  const r = await app.call('/api/login', { body: { username: 'owner', password: 'wrong-password', company_id: 1, mode: 'LIVE' } });
  assert.equal(r.status, 401);
  assert.equal(fs.existsSync(path.join(process.env.FINANCE_DATA_DIR!, 'live.db')), false, 'company 1 file must not be downloaded');
});

test('invalid sync device token is rejected before any organization data is loaded', { skip: SKIP }, async () => {
  freshInstance();
  const r = await app.call('/api/sync/exchange', { body: { events: [] }, headers: { 'x-aksh-company-id': '1', 'x-aksh-mode': 'LIVE', 'x-solivy-device-token': 'forged', 'x-solivy-device-id': 'dev1' } });
  assert.equal(r.status, 401);
  assert.equal(fs.existsSync(path.join(process.env.FINANCE_DATA_DIR!, 'live.db')), false);
});

test('20 concurrent writes to the same organization are all persisted (per-org lock)', { skip: SKIP }, async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => app.call('/api/parties', { cookie, body: { name: `Concurrent ${i}`, party_type: 'GOODS_VENDOR' } })));
  assert.deepEqual(results.map((r) => r.status), Array(20).fill(200));
  freshInstance();
  const data = app.expectOk(await app.call('/api/data', { cookie }));
  assert.equal(data.parties.filter((p: any) => String(p.name).startsWith('Concurrent ')).length, 20);
});

test('idempotent retry posts once and replays the stored response', { skip: SKIP }, async () => {
  const body = { name: 'Idem Vendor', party_type: 'GOODS_VENDOR' };
  const a = await app.call('/api/parties', { cookie, body, headers: { 'idempotency-key': 'online-k1' } });
  freshInstance();
  const b = await app.call('/api/parties', { cookie, body, headers: { 'idempotency-key': 'online-k1' } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  const data = app.expectOk(await app.call('/api/data', { cookie }));
  assert.equal(data.parties.filter((p: any) => p.name === 'Idem Vendor').length, 1);
});

test('a failed PostgreSQL write returns 503 and nothing is recorded', { skip: SKIP }, async () => {
  await sql(`CREATE OR REPLACE FUNCTION solivy_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$ LANGUAGE plpgsql`);
  await sql(`CREATE TRIGGER solivy_fail_tr BEFORE UPDATE ON solivy_sqlite_snapshots FOR EACH ROW WHEN (NEW.db_key = 'company:1:LIVE') EXECUTE FUNCTION solivy_fail()`);
  try {
    const r = await app.call('/api/parties', { cookie, body: { name: 'Lost Vendor', party_type: 'GOODS_VENDOR' } });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'DATABASE_PERSIST_FAILED');
  } finally { await sql('DROP TRIGGER solivy_fail_tr ON solivy_sqlite_snapshots'); }
  const data = app.expectOk(await app.call('/api/data', { cookie })); // same instance: stale local copy must not leak
  assert.equal(data.parties.some((p: any) => p.name === 'Lost Vendor'), false);
});

test('a corrupted chunk is detected and never served; a corrupted base blob falls back to chunks', { skip: SKIP }, async () => {
  const { encodeBlob } = await import('../../lib/snapshot-store');
  // Write so that some chunks differ from the stored base blob, then corrupt one of those: a cold
  // instance has to fetch it, so the integrity check must fire.
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Integrity Probe ' + Date.now(), party_type: 'GOODS_VENDOR' } }));
  const { decodeBlob, manifestOf } = await import('../../lib/snapshot-store');
  const row = (await sql("SELECT encode(manifest_z,'base64') AS mz, chunk_size, encode(db_file,'base64') AS blob FROM solivy_sqlite_snapshots WHERE db_key='company:1:LIVE'")).rows[0];
  const manifest = decodeBlob(Buffer.from(String(row.mz), 'base64')).toString('utf8').split(',');
  const baseManifest = manifestOf(decodeBlob(Buffer.from(String(row.blob), 'base64')), Number(row.chunk_size));
  const target = manifest.findIndex((h: string, i: number) => baseManifest[i] !== h);
  assert.ok(target >= 0, 'a write must leave at least one chunk differing from the base blob');
  const original = (await sql('SELECT data FROM solivy_sqlite_chunks WHERE db_key=$1 AND chunk_no=$2', ['company:1:LIVE', target])).rows[0].data;
  await sql('UPDATE solivy_sqlite_chunks SET data=$1 WHERE db_key=$2 AND chunk_no=$3', [encodeBlob(Buffer.alloc(4096, 7)), 'company:1:LIVE', target]);
  try {
    freshInstance();
    const r = await app.call('/api/data', { cookie });
    assert.equal(r.status, 500, r.text.slice(0, 200));
    assert.match(r.text, /integrity/);
  } finally { await sql('UPDATE solivy_sqlite_chunks SET data=$1 WHERE db_key=$2 AND chunk_no=$3', [original, 'company:1:LIVE', target]); }
  freshInstance();
  assert.equal((await app.call('/api/data', { cookie })).status, 200);
  // A corrupted base blob must not be trusted either: the read falls back to the chunk set.
  const base = (await sql("SELECT db_file FROM solivy_sqlite_snapshots WHERE db_key='company:1:LIVE'")).rows[0].db_file;
  await sql("UPDATE solivy_sqlite_snapshots SET db_file=$1 WHERE db_key='company:1:LIVE'", [encodeBlob(Buffer.alloc(Number(base.length), 9))]);
  try {
    freshInstance();
    const r = await app.call('/api/data', { cookie });
    assert.equal(r.status, 200, 'served from chunks when the base blob is unusable');
    assert.ok(Array.isArray(r.json.parties));
  } finally { await sql("UPDATE solivy_sqlite_snapshots SET db_file=$1 WHERE db_key='company:1:LIVE'", [base]); }
});

test('legacy v2.6.30 whole-file row is read, converted to chunks and backed up before migration', { skip: SKIP }, async () => {
  // Build a legacy-format org database the way v2.6.30 left it: full schema, user_version 0,
  // no schema_migrations table, stored as one raw BYTEA row.
  const Database = require('better-sqlite3');
  app.expectOk(await app.call('/api/data', { cookie }));
  const src = path.join(process.env.FINANCE_DATA_DIR!, 'live.db');
  const tmp = path.join(process.env.FINANCE_DATA_DIR!, '..', `legacy-${process.pid}.db`);
  fs.copyFileSync(src, tmp);
  const legacy = new Database(tmp);
  legacy.exec("DROP TABLE schema_migrations; DELETE FROM parties; INSERT INTO parties(name) VALUES('Legacy Co');"); legacy.pragma('user_version = 0'); legacy.pragma('journal_mode = DELETE');
  legacy.close();
  const bytes = fs.readFileSync(tmp); fs.unlinkSync(tmp);
  await sql("DELETE FROM solivy_sqlite_chunks WHERE db_key='company:1:TEST'");
  await sql("INSERT INTO solivy_sqlite_snapshots(db_key, db_file) VALUES('company:1:TEST',$1) ON CONFLICT (db_key) DO UPDATE SET db_file=EXCLUDED.db_file, format=1, manifest=NULL, version=0, sha256=NULL", [bytes]);
  const sw = await app.call('/api/switch-environment', { cookie, body: { mode: 'TEST' } });
  assert.equal(sw.status, 200, sw.text);
  const testCookie = sw.cookie!;
  freshInstance();
  const data = app.expectOk(await app.call('/api/data', { cookie: testCookie }));
  assert.ok(data.parties.some((p: any) => p.name === 'Legacy Co'));
  const row = (await sql("SELECT format FROM solivy_sqlite_snapshots WHERE db_key='company:1:TEST'")).rows[0];
  assert.equal(Number(row.format), 2, 'converted to chunked format after migration');
  const backups = (await sql("SELECT reason FROM solivy_sqlite_snapshot_backups WHERE db_key='company:1:TEST'")).rows;
  assert.ok(backups.some((b: any) => /pre-migration v0->v27/.test(b.reason)));
});

test('online backup / restore / rollback with the snapshot tool (integrity-checked, previous version kept)', { skip: SKIP }, async () => {
  const { run } = await import('../../scripts/online-snapshot-tool');
  const quiet = () => {};
  const out = path.join(process.env.FINANCE_DATA_DIR!, '..', `export-${process.pid}.db`);
  freshInstance();
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Before Restore', party_type: 'GOODS_VENDOR' } }));
  await run(['export', 'company:1:LIVE', out], quiet);
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'After Export', party_type: 'GOODS_VENDOR' } }));
  const dry = await run(['import', 'company:1:LIVE', out], quiet) as any;
  assert.equal(dry.dryRun, true);
  await run(['import', 'company:1:LIVE', out, '--confirm'], quiet);
  freshInstance();
  let names = app.expectOk(await app.call('/api/data', { cookie })).parties.map((p: any) => p.name);
  assert.ok(names.includes('Before Restore')); assert.ok(!names.includes('After Export'), 'restored to the exported point');
  // Roll back the restore using the automatic "before import" backup.
  const backups = await run(['backups', 'company:1:LIVE'], quiet) as any[];
  const before = backups.find((b) => /^before import/.test(b.reason));
  await run(['restore-backup', String(before.id), '--confirm'], quiet);
  freshInstance();
  names = app.expectOk(await app.call('/api/data', { cookie })).parties.map((p: any) => p.name);
  assert.ok(names.includes('After Export'), 'rollback brought back the later data');
  fs.writeFileSync(out, 'not a database');
  await assert.rejects(run(['import', 'company:1:LIVE', out, '--confirm'], quiet), /Not a SQLite/);
});

test('4 KiB page-aligned chunks: one posting uploads a few chunks, not the whole file', { skip: SKIP }, async () => {
  const { transferStats } = await import('../../lib/snapshot-store');
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Chunk Probe A', party_type: 'GOODS_VENDOR' } }));
  const { decodeBlob: dec } = await import('../../lib/snapshot-store');
  const row = (await sql("SELECT chunk_size, size_bytes::bigint size, encode(manifest_z,'base64') AS mz FROM solivy_sqlite_snapshots WHERE db_key='company:1:LIVE'")).rows[0];
  assert.equal(Number(row.chunk_size), 4096, 'chunks are one SQLite page');
  const chunks = dec(Buffer.from(String(row.mz), 'base64')).toString('utf8').split(',').length;
  // The bridge resets these counters at the start of every request, so after the call they hold
  // exactly what that one request transferred.
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Chunk Probe B', party_type: 'GOODS_VENDOR' } }));
  const uploadedChunks = transferStats.chunksUp;
  const uploadedBytes = transferStats.bytesUp;
  assert.ok(uploadedChunks > 0 && uploadedChunks < Math.max(12, chunks * 0.1), `one posting uploaded ${uploadedChunks} of ${chunks} chunks`);
  assert.ok(uploadedBytes < Number(row.size) / 4, `uploaded ${uploadedBytes} bytes for a file of ${row.size}`);
});

test('a cold instance reads the whole-file base blob plus the chunks that changed after it', { skip: SKIP }, async () => {
  const { transferStats } = await import('../../lib/snapshot-store');
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Base Probe ' + Date.now(), party_type: 'GOODS_VENDOR' } }));
  freshInstance();
  const r = app.expectOk(await app.call('/api/data', { cookie, query: { modules: 'core,parties' } }));
  assert.ok(r.parties.some((p: any) => /^Base Probe/.test(p.name)), 'the newest row is present after a cold read');
  assert.equal(transferStats.baseDownloads, 2, 'admin.db and the organization file each came from one base blob');
  assert.equal(transferStats.fullDownloads, 0, 'no full chunk-by-chunk reload was needed');
  const size = Number((await sql("SELECT size_bytes::bigint s FROM solivy_sqlite_snapshots WHERE db_key='company:1:LIVE'")).rows[0].s);
  assert.ok(transferStats.bytesDown < size, 'a cold read transfers less than the uncompressed file');
});

test('the sign-in screen reads the projection row and never hydrates admin.db', { skip: SKIP }, async () => {
  const { transferStats } = await import('../../lib/snapshot-store');
  app.expectOk(await app.call('/api/data', { cookie })); // ensure the projection has been published
  const projected = (await sql("SELECT payload FROM solivy_public_projections WHERE key='login_companies'")).rows[0];
  assert.ok(projected, 'the projection row exists');
  const rows = JSON.parse(projected.payload);
  assert.ok(rows.length >= 1 && rows[0].name && rows[0].code, 'it holds organization name and code only');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'id', 'name'], 'nothing else is projected');
  freshInstance();
  const r = app.expectOk(await app.call('/api/login-companies', {}));
  assert.equal(r.companies.length, rows.length);
  assert.equal(transferStats.bytesDown, 0, 'no snapshot bytes were downloaded for the public sign-in screen');
});

test('transfer diagnostics record per-endpoint bytes without query strings', { skip: SKIP }, async () => {
  app.expectOk(await app.call('/api/data', { cookie, query: { modules: 'core' } }));
  const r = app.expectOk(await app.call('/api/admin/transfer-metrics', { cookie, query: { days: 2 } }));
  assert.equal(r.storage, 'postgres');
  assert.match(r.note, /lower bound|provider/i, 'the report states it is not the provider bill');
  assert.ok(r.totals.requests > 0 && r.endpoints.length > 0);
  assert.ok(r.endpoints.every((e: any) => !String(e.endpoint).includes('?')), 'query strings are never stored');
  assert.ok(r.snapshots.some((s: any) => s.db_key === 'company:1:LIVE' && Number(s.chunk_size) === 4096));
  // Role enforcement itself is covered offline (tests/integration/security.test.ts): the
  // middleware replaces client identity headers, so a forged role cannot be tested from here.
});

test('a write by another instance is visible immediately: no conditional cache can hide it', { skip: SKIP }, async () => {
  const first = await app.call('/api/data', { cookie, query: { modules: 'core,parties' } });
  const etag = first.headers.get('etag')!;
  // Simulate a second application instance: write with a cleared local cache, then revalidate.
  freshInstance();
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Other Instance Vendor', party_type: 'GOODS_VENDOR' } }));
  freshInstance();
  const revalidated = await app.call('/api/data', { cookie, query: { modules: 'core,parties' }, headers: { 'If-None-Match': etag } });
  assert.equal(revalidated.status, 200, 'the old representation must not be confirmed after another instance wrote');
  assert.ok(revalidated.json.parties.some((p: any) => p.name === 'Other Instance Vendor'));
});
