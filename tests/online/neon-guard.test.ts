/**
 * v2.7.2 NEON GUARD — the transfer safeguards, against a real PostgreSQL server.
 * Requires SOLIVY_TEST_PG_URL; without it every test is reported SKIPPED, never passed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PG = process.env.SOLIVY_TEST_PG_URL || '';
const SKIP = PG ? false : 'NOT VERIFIED: SOLIVY_TEST_PG_URL not set (no PostgreSQL available)';
const DB = `solivy_guard_${process.pid}_${Date.now()}`;
const SETUP_SECRET = 'guard-test-setup-secret-0123456789';

let pg: any; let app: typeof import('../helpers/app'); let cookie = '';
let store: typeof import('../../lib/snapshot-store');
let bridge: typeof import('../../lib/postgres-sqlite-bridge');

const sql = (text: string, values: any[] = []) => pg.query(text, values);
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
  store = await import('../../lib/snapshot-store');
  bridge = await import('../../lib/postgres-sqlite-bridge');
  const setup = await app.call('/api/setup', { body: { setupSecret: SETUP_SECRET, username: 'owner', name: 'Owner', email: 'owner@example.test', password: 'Correct-Horse-Battery-9', confirmPassword: 'Correct-Horse-Battery-9' } });
  assert.equal(setup.status, 200, setup.text);
  cookie = await app.login('owner', 1, 'LIVE', 'Correct-Horse-Battery-9');
  const { seedFinance } = await import('../helpers/seed-finance');
  await seedFinance(cookie);
});
after(async () => { if (!SKIP) { try { await pg.end(); } catch {} } });

/** Every registered READ endpoint, with arguments that make it do real work. */
const READ_CALLS: Array<{ path: string; query?: Record<string, string>; method?: string; body?: any }> = [
  { path: '/api/data', query: { modules: 'core,parties,accounts,purchases,payments,money,ledger,receivables,funding,account-history' } },
  { path: '/api/data' },
  { path: '/api/accounts' },
  { path: '/api/account-movements' },
  { path: '/api/bank' },
  { path: '/api/budgets', query: { fy: '2026-27' } },
  { path: '/api/companies' },
  { path: '/api/document-settings' },
  { path: '/api/document-templates' },
  { path: '/api/export/gst', query: { from: '2026-04-01', to: '2027-03-31' } },
  { path: '/api/export/ledger' },
  { path: '/api/export/payments' },
  { path: '/api/export/purchases' },
  { path: '/api/funding' },
  { path: '/api/godowns' },
  { path: '/api/group-mis' },
  { path: '/api/intercompany-targets', query: { company_id: '1' } },
  { path: '/api/license/status' },
  { path: '/api/login-companies' },
  { path: '/api/party-aliases' },
  { path: '/api/profile' },
  { path: '/api/receivables' },
  { path: '/api/reports' },
  { path: '/api/reports', query: { id: 'trial-balance', as_of: '2027-03-31' } },
  { path: '/api/reports', query: { id: 'general-ledger', from: '2026-04-01', to: '2027-03-31' } },
  { path: '/api/reports', query: { id: 'ar-aging', as_of: '2027-03-31' } },
  { path: '/api/reports', query: { id: 'balance-sheet', as_of: '2027-03-31' } },
  { path: '/api/reports', query: { id: 'trial-balance', as_of: '2027-03-31', format: 'csv' } },
  { path: '/api/reports/group' },
  { path: '/api/saudas' },
  { path: '/api/secondary-backup' },
  { path: '/api/setup' },
  { path: '/api/tally-export', query: { types: 'purchases' } },
  { path: '/api/tally-mapping' },
  { path: '/api/transfers' },
  { path: '/api/transfers/destinations' },
  { path: '/api/users' },
  { path: '/api/admin/data-health' },
  { path: '/api/admin/transfer-metrics', query: { days: '2' } },
  { path: '/api/backup' },
  { path: '/api/admin-backup-all' },
  { path: '/api/purchase-bill', query: { id: '1' } },
  { path: '/api/payment-advice', query: { id: '1' } },
  { path: '/api/tds-check', method: 'POST', body: { party_id: 1, amount: 100000 } },
];

test('READ endpoints never upload a snapshot, and no read is answered from a cache the server did not confirm', { skip: SKIP }, async () => {
  bridge.resetBridgeGuardStats();
  const uploaded: string[] = [];
  for (const c of READ_CALLS) {
    const before = (await sql('SELECT COALESCE(SUM(version),0)::text v FROM solivy_sqlite_snapshots')).rows[0].v;
    const r = await app.call(c.path, { cookie, query: c.query, method: c.method, body: c.body });
    assert.ok(r.status < 500, `${c.path} returned ${r.status}: ${r.text.slice(0, 160)}`);
    const upBytes = store.transferStats.bytesUp;
    const after = (await sql('SELECT COALESCE(SUM(version),0)::text v FROM solivy_sqlite_snapshots')).rows[0].v;
    if (upBytes > 0 || after !== before) uploaded.push(`${c.method || 'GET'} ${c.path} (${upBytes} B, versions ${before}->${after})`);
  }
  assert.deepEqual(uploaded, [], 'no READ endpoint may write snapshot data');
  assert.equal(bridge.bridgeGuardStats().readPersistBlocked, 0, 'no read-only guard violation was triggered either');
});

test('an unchanged request transfers nothing beyond the version check', { skip: SKIP }, async () => {
  const first = await app.call('/api/data', { cookie, query: { modules: 'core,parties,purchases' } });
  const etag = first.headers.get('etag')!;
  for (let i = 0; i < 3; i++) {
    const again = await app.call('/api/data', { cookie, query: { modules: 'core,parties,purchases' }, headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(store.transferStats.bytesUp, 0, 'a 304 uploads nothing');
    assert.equal(store.transferStats.chunksDown, 0, 'a 304 downloads no chunks');
    assert.equal(store.transferStats.baseDownloads, 0, 'a 304 downloads no base blob');
  }
  // Without the conditional header the body is rebuilt, but still nothing is written.
  const full = await app.call('/api/data', { cookie, query: { modules: 'core,parties,purchases' } });
  assert.equal(full.status, 200);
  assert.equal(store.transferStats.bytesUp, 0);
});

test('a NO_DB endpoint reaches neither PostgreSQL nor a snapshot', { skip: SKIP }, async () => {
  const before = (await sql('SELECT COALESCE(SUM(version),0)::text v FROM solivy_sqlite_snapshots')).rows[0].v;
  freshInstance();
  const r = await app.call('/api/logout', { cookie, body: {} });
  assert.ok(r.status < 400, r.text.slice(0, 120));
  assert.equal(store.transferStats.bytesDown, 0, 'nothing was downloaded');
  assert.equal(store.transferStats.bytesUp, 0, 'nothing was uploaded');
  assert.equal((await sql('SELECT COALESCE(SUM(version),0)::text v FROM solivy_sqlite_snapshots')).rows[0].v, before);
  assert.equal(fs.readdirSync(process.env.FINANCE_DATA_DIR!).length, 0, 'no snapshot was materialised on disk');
});

test('WRITE endpoints persist only what actually changed', { skip: SKIP }, async () => {
  const versionOf = async (key: string) => (await sql('SELECT version::text v FROM solivy_sqlite_snapshots WHERE db_key=$1', [key])).rows[0].v;
  const before = await versionOf('company:1:LIVE');
  app.expectOk(await app.call('/api/parties', { cookie, body: { name: 'Guard Vendor ' + Date.now(), party_type: 'GOODS_VENDOR' } }));
  const afterWrite = await versionOf('company:1:LIVE');
  assert.notEqual(afterWrite, before, 'a real change bumps the version once');
  const uploadedChunks = store.transferStats.chunksUp;
  assert.ok(uploadedChunks > 0 && uploadedChunks < 40, `only changed pages are uploaded (${uploadedChunks})`);
  // A write that the handler rejects must leave the snapshot untouched.
  const rejected = await app.call('/api/parties', { cookie, body: { name: '' } });
  assert.ok(rejected.status >= 400, 'invalid payload is refused');
  assert.equal(await versionOf('company:1:LIVE'), afterWrite, 'a refused write persists nothing');
  assert.equal(store.transferStats.bytesUp, 0, 'a refused write uploads nothing');
});

test('identical concurrent reads are coalesced into one hydration', { skip: SKIP }, async () => {
  freshInstance();
  bridge.resetBridgeGuardStats();
  const q = { modules: 'core,parties,purchases' };
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => app.call('/api/data', { cookie, query: q })));
  for (const r of results) assert.equal(r.status, 200);
  const bodies = new Set(results.map((r) => JSON.stringify(r.json.parties?.length)));
  assert.equal(bodies.size, 1, 'all callers see the same data');
  assert.ok(bridge.bridgeGuardStats().coalescedReads >= 1, `at least one read was shared (${bridge.bridgeGuardStats().coalescedReads})`);
  assert.equal(store.transferStats.fullDownloads, 0);
});

test('caches are isolated by organization, environment, user and permissions', { skip: SKIP }, async () => {
  // A second organization and a restricted user, created through the API so the bridge persists
  // them. Administration writes revoke existing sessions by design, so both sessions are renewed.
  const created = app.expectOk(await app.call('/api/companies', { cookie, body: { name: 'Guard Org Two', code: 'GUARD2' } }));
  cookie = await app.login('owner', 1, 'LIVE', 'Correct-Horse-Battery-9');
  app.expectOk(await app.call('/api/users', { cookie, body: { username: 'guardclerk', name: 'Clerk', password: 'Correct-Horse-9', role: 'DATA_ENTRY', email: 'clerk@example.test', menu_access: ['dashboard', 'parties'], assignments: [{ company_id: 1, can_live: true, can_test: false }] } }));
  cookie = await app.login('owner', 1, 'LIVE', 'Correct-Horse-Battery-9');
  const clerk = await app.login('guardclerk', 1, 'LIVE', 'Correct-Horse-9');

  const q = { modules: 'core,parties' };
  const owner = await app.call('/api/data', { cookie, query: q });
  const ownerEtag = owner.headers.get('etag')!;
  // Same URL, different user with fewer permissions: the owner's representation must not be confirmed.
  const asClerk = await app.call('/api/data', { cookie: clerk, query: q, headers: { 'If-None-Match': ownerEtag } });
  assert.equal(asClerk.status, 200, 'another user never reuses this user’s cached representation');
  assert.notEqual(asClerk.headers.get('etag'), ownerEtag);
  // Same user, other environment.
  const test = await app.call('/api/data', { cookie, query: q, headers: { 'x-aksh-mode': 'TEST', 'If-None-Match': ownerEtag } });
  assert.notEqual(test.status, 304, 'TEST never reuses a LIVE representation');
  // Same user, other organization: not granted, so it must be refused rather than served.
  const otherOrg = await app.call('/api/data', { cookie, query: q, headers: { 'x-aksh-company-id': String(created.id) } });
  assert.ok(otherOrg.status === 200 ? JSON.stringify(otherOrg.json) !== JSON.stringify(owner.json) : otherOrg.status >= 400,
    'another organization never returns this organization’s data');
});

test('monthly budget alerts fire once per threshold and are measured, not estimated', { skip: SKIP }, async () => {
  const { budgetState, ALERTS_TABLE, THRESHOLDS } = await import('../../lib/transfer-budget');
  const { flushMetrics, METRICS_TABLE } = await import('../../lib/transfer-metrics');
  const client = await (await import('../../lib/postgres')).postgresPool().connect();
  try {
    await flushMetrics(client);
    await client.query(`DELETE FROM ${ALERTS_TABLE}`);
    const month = new Date().toISOString().slice(0, 10);
    // 60% of a 1 GB budget.
    process.env.SOLIVY_TRANSFER_BUDGET_GB = '1';
    await client.query(`DELETE FROM ${METRICS_TABLE}`);
    await client.query(`INSERT INTO ${METRICS_TABLE}(day, endpoint, method, company_id, mode, requests, pg_down_bytes, pg_up_bytes) VALUES($1,'/api/data','GET',1,'LIVE',10,$2,0)`, [month, Math.round(0.6 * 1024 ** 3)]);
    const first = await budgetState(client);
    assert.equal(first.status, 'warning');
    assert.deepEqual(first.reached, [50]);
    assert.deepEqual(first.newly_reached, [50], 'the 50% threshold is raised once');
    const second = await budgetState(client);
    assert.deepEqual(second.newly_reached, [], 'it is not raised again');
    // Push past 100%.
    await client.query(`UPDATE ${METRICS_TABLE} SET pg_down_bytes=$1 WHERE day=$2`, [Math.round(1.2 * 1024 ** 3), month]);
    const over = await budgetState(client);
    assert.equal(over.status, 'over');
    assert.deepEqual(over.reached, [...THRESHOLDS]);
    assert.deepEqual(over.newly_reached, [75, 90, 100]);
    assert.match(over.note, /lower bound|provider/i, 'the figure is labelled application-measured');
    assert.ok(over.projected_percent >= over.percent - 1, 'a month-end projection is provided');
    const raised = (await client.query(`SELECT threshold FROM ${ALERTS_TABLE} ORDER BY threshold`)).rows.map((r: any) => Number(r.threshold));
    assert.deepEqual(raised, [50, 75, 90, 100]);
  } finally { delete process.env.SOLIVY_TRANSFER_BUDGET_GB; client.release(); }
});

test('a transfer spike names the responsible endpoint, not the busiest one', { skip: SKIP }, async () => {
  const { spikes, SPIKE_MIN_BYTES } = await import('../../lib/transfer-budget');
  const { METRICS_TABLE } = await import('../../lib/transfer-metrics');
  const client = await (await import('../../lib/postgres')).postgresPool().connect();
  try {
    await client.query(`DELETE FROM ${METRICS_TABLE}`);
    const add = (dayOffset: number, endpoint: string, bytes: number, access = 'READ') => client.query(
      `INSERT INTO ${METRICS_TABLE}(day, endpoint, method, company_id, mode, access, requests, pg_down_bytes) VALUES(CURRENT_DATE - $1::int, $2, 'GET', 1, 'LIVE', $3, 5, $4)
       ON CONFLICT (day, endpoint, method, company_id, mode) DO UPDATE SET pg_down_bytes=EXCLUDED.pg_down_bytes`, [dayOffset, endpoint, access, bytes]);
    // A consistently large endpoint, and a small one that explodes today.
    for (let d = 1; d <= 7; d++) { await add(d, '/api/data', 40 * 1024 * 1024); await add(d, '/api/reports', 1024 * 1024); }
    await add(0, '/api/data', 42 * 1024 * 1024);
    await add(0, '/api/reports', 30 * 1024 * 1024);
    const r = await spikes(client, 14);
    assert.ok(r.worst, 'a spike was detected');
    assert.equal(r.worst!.endpoint, '/api/reports', 'the endpoint that moved far above its own normal is named');
    assert.ok(r.worst!.factor >= 3);
    assert.ok(!r.spikes.some((s) => s.endpoint === '/api/data'), 'a steadily large endpoint is not flagged as a spike');
    assert.ok(SPIKE_MIN_BYTES > 0);
  } finally { client.release(); }
});

test('the diagnostics API reports access classes, budget, spikes and guard counters', { skip: SKIP }, async () => {
  app.expectOk(await app.call('/api/data', { cookie, query: { modules: 'core' } }));
  const r = app.expectOk(await app.call('/api/admin/transfer-metrics', { cookie, query: { days: '3' } }));
  assert.equal(r.storage, 'postgres');
  assert.ok(r.budget && typeof r.budget.percent === 'number' && r.budget.budget_bytes > 0);
  assert.ok(Array.isArray(r.spikes.spikes));
  assert.ok(r.guards.declared_routes > 50, 'every route declares an access class');
  assert.equal(r.guards.readPersistBlocked, 0);
  assert.ok(r.access.some((a: any) => a.access === 'READ' || a.access === 'WRITE'));
  assert.ok(r.endpoints.every((e: any) => !String(e.endpoint).includes('?')));
});
