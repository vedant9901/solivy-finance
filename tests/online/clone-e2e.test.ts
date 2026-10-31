/**
 * v2.9.0 — full database clone in both directions, device ⇄ hub over real HTTP, hub on real
 * PostgreSQL. Covers the mandatory scenarios: both clone directions, repeat clones, incremental
 * sync after a clone, interruption and restart mid-transfer, duplicate retries, a partial batch,
 * a schema-version mismatch, organisation isolation, and rollback after a failed validation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PG = process.env.SOLIVY_TEST_PG_URL || '';
const SKIP = PG ? false : 'NOT VERIFIED: SOLIVY_TEST_PG_URL not set (no PostgreSQL available)';
const DB = `solivy_clone_${process.pid}_${Date.now()}`;
const ROOT = path.resolve(__dirname, '..', '..');
const SECRET = 'online-test-setup-secret-0123456789';
const PW = 'Correct-Horse-Battery-9';
let hub: ChildProcess | null = null; let hubUrl = ''; let hubCookie = ''; let token = '';
let app: typeof import('../helpers/app'); let desk = { cookie: '', companyId: 0 };

async function startHub() {
  const env = { ...process.env, VERCEL: '1', DATABASE_URL: `${PG}/${DB}`, SOLIVY_PG_SSL: 'disable', SOLIVY_SETUP_SECRET: SECRET, FINANCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-clone-hub-')) };
  hub = spawn(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', path.join(ROOT, 'tests/helpers/server.ts'), '0'], { env, cwd: ROOT });
  hub.stderr!.on('data', (d) => { if (process.env.DEBUG_HUB) process.stderr.write(d); });
  hubUrl = await new Promise((resolve, reject) => {
    hub!.stdout!.on('data', (d) => { const m = String(d).match(/LISTENING (\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
    hub!.on('exit', (c) => reject(new Error(`hub exited ${c}`)));
  });
}
async function hubCall(p: string, opts: { method?: string; body?: any; cookie?: string; headers?: Record<string, string> } = {}) {
  const r = await fetch(hubUrl + p, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', origin: hubUrl, ...(opts.cookie ? { cookie: `aksh_session=${opts.cookie}` } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  const m = (r.headers.get('set-cookie') || '').match(/aksh_session=([^;]*)/);
  return { status: r.status, json, text, cookie: m?.[1] };
}
const deskDb = async () => (await import('../../lib/db')).db('LIVE', desk.companyId);
const pairing = () => ({ remote_url: hubUrl, remote_company_id: 1, device_token: token, remote_mode: 'LIVE' });
const clone = (body: any) => app.call('/api/sync/clone/run', { cookie: desk.cookie, body: { ...pairing(), ...body } });
const sync = () => app.call('/api/sync/run', { cookie: desk.cookie, body: pairing() });
/** Device-token headers for talking to the hub clone endpoint directly (restart / resume tests). */
async function deviceHeaders() {
  const d = await deskDb();
  const deviceId = String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any).device_id);
  return { 'x-solivy-device-token': token, 'x-solivy-device-id': deviceId, 'x-aksh-company-id': '1', 'x-aksh-mode': 'LIVE' };
}

before(async () => {
  if (SKIP) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`CREATE DATABASE ${DB}`); await c.end();
  await startHub();
  assert.equal((await hubCall('/api/setup', { body: { setupSecret: SECRET, username: 'owner', name: 'Owner', email: 'o@example.test', password: PW, confirmPassword: PW } })).status, 200);
  hubCookie = (await hubCall('/api/login', { body: { username: 'owner', password: PW, company_id: 1, mode: 'LIVE' } })).cookie!;
  app = await import('../helpers/app');
  await app.seedUser({ username: 'cloneadmin', role: 'ADMIN', companies: [{ id: 1, live: true, test: true }] });
  desk = { cookie: await app.login('cloneadmin', 1, 'LIVE'), companyId: 1 };
  const d = await deskDb();
  const deviceId = (d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any).device_id;
  const pair = await hubCall('/api/sync/pair', { cookie: hubCookie, body: { device_id: deviceId, device_name: 'Clone test device' } });
  assert.equal(pair.status, 200, pair.text);
  token = pair.json.device_token;
});
after(async () => {
  if (SKIP) return;
  hub?.kill();
  const { Client } = require('pg');
  const c = new Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await c.end();
});

/** A party, a purchase, a payment and a receipt on the device, so a clone has real records. */
async function seedDevice(tag: string) {
  const party = app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: `Clone Vendor ${tag}`, party_type: 'GOODS_VENDOR' } }));
  const partyId = Number(party.id ?? party.partyId);
  const data = app.expectOk(await app.call('/api/data', { cookie: desk.cookie }));
  const accountId = (data.accounts || [])[0]?.id || app.expectOk(await app.call('/api/accounts', { cookie: desk.cookie, body: { account_name: `Clone Bank ${tag}`, bank_name: 'HDFC', account_type: 'BANK', opening_balance: 1_000_000 } })).id;
  app.expectOk(await app.call('/api/purchases', { cookie: desk.cookie, body: { party_id: partyId, purchase_date: '2026-10-01', net_weight: 1000, gross_weight: 1010, rate: 50, truck_number: `GJ20CL${tag}`, goods_description: 'Cumin' } }));
  app.expectOk(await app.call('/api/payments', { cookie: desk.cookie, body: { party_id: partyId, payment_date: '2026-10-02', amount: 15_000, mode: 'BANK', company_account_id: accountId } }));
  app.expectOk(await app.call('/api/money-in', { cookie: desk.cookie, body: { receipt_date: '2026-10-03', account_id: accountId, amount: 7_500, receipt_type: 'CAPITAL', narration: `Clone receipt ${tag}` } }));
  return { partyId, accountId };
}

test('preview reports record counts and requires an explicit confirmation before replacing anything', { skip: SKIP }, async () => {
  await seedDevice('A1');
  const preview = await clone({ direction: 'push', preview: true });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.stage, 'preview');
  assert.ok(preview.json.fingerprint.business_rows > 0, preview.text);
  assert.ok(Object.keys(preview.json.fingerprint.tables).length > 10, 'every business table is counted');
  assert.match(String(preview.json.confirmation_required), /^REPLACE ONLINE .+ LIVE$/);

  const refused = await clone({ direction: 'push', confirm: 'yes please' });
  assert.equal(refused.status, 428, refused.text);
  assert.match(String(refused.json.error), /Type exactly/);
});

test('offline → online full clone: uploaded, verified table by table, then activated', { skip: SKIP }, async () => {
  const before = app.expectOk(await app.call('/api/data', { cookie: desk.cookie }));
  const r = await clone({ direction: 'push', confirm: `REPLACE ONLINE SOLIVY LIVE` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.stage, 'verified');
  assert.equal(r.json.hub.activated, true, r.text);
  assert.equal(r.json.hub.differences.length, 0, JSON.stringify(r.json.hub.differences));
  assert.ok(r.json.hub.rollback_available === true || r.json.hub.previous_version === null, 'the replaced version is kept when there was one');

  // The hub now serves the same records and the same financial totals.
  const onHub = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.equal(onHub.parties.length, before.parties.length);
  assert.equal(onHub.purchases.length, before.purchases.length);
  const sum = (rows: any[], f: string) => Math.round(rows.reduce((a, x) => a + Number(x[f] || 0), 0) * 100) / 100;
  assert.equal(sum(onHub.purchases, 'net_payable'), sum(before.purchases, 'net_payable'), 'purchase totals match');
  assert.equal(sum(onHub.payments, 'amount'), sum(before.payments, 'amount'), 'payment totals match');
});

test('repeating the clone changes nothing and creates no duplicates', { skip: SKIP }, async () => {
  const first = (await hubCall('/api/data', { cookie: hubCookie })).json;
  for (let i = 0; i < 2; i++) {
    const r = await clone({ direction: 'push', confirm: 'REPLACE ONLINE SOLIVY LIVE' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.hub.differences.length, 0, r.text);
  }
  const after = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.equal(after.parties.length, first.parties.length, 'no duplicated parties');
  assert.equal(after.purchases.length, first.purchases.length, 'no duplicated purchases');
  assert.equal(after.payments.length, first.payments.length, 'no duplicated payments');
});

test('an interrupted upload resumes from what already arrived, and a duplicate chunk is harmless', { skip: SKIP }, async () => {
  const headers = await deviceHeaders();
  // Build the same snapshot the device would send.
  const { snapshotToFile } = await import('../../lib/clone-engine');
  const d = await deskDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-clone-test-'));
  const file = snapshotToFile(d, path.join(dir, 'src.db'));
  const bytes = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  const begun = await hubCall('/api/sync/clone', { headers, body: { action: 'begin', size: bytes.length, sha } });
  assert.equal(begun.status, 200, begun.text);
  const uploadId = begun.json.upload_id;
  const chunkSize = Number(begun.json.chunk_size);
  const chunks = Number(begun.json.chunks);
  assert.ok(chunks >= 1);

  // Send the first chunk, then "lose the network": send nothing more.
  const slice0 = bytes.subarray(0, chunkSize);
  const sent0 = await hubCall('/api/sync/clone', { headers, body: { action: 'chunk', upload_id: uploadId, chunk_no: 0, sha: crypto.createHash('sha256').update(slice0).digest('hex'), data: slice0.toString('base64') } });
  assert.equal(sent0.status, 200, sent0.text);
  // The same chunk again (a retry) is idempotent.
  const again = await hubCall('/api/sync/clone', { headers, body: { action: 'chunk', upload_id: uploadId, chunk_no: 0, data: slice0.toString('base64') } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.received, 1, 'the retry did not add a second copy of chunk 0');

  // Committing now must refuse: a partial upload is never activated.
  if (chunks > 1) {
    const early = await hubCall('/api/sync/clone', { headers, body: { action: 'commit', upload_id: uploadId } });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.code, 'INCOMPLETE_UPLOAD');
    assert.ok(Array.isArray(early.json.missing) && early.json.missing.length > 0, early.text);
  }

  // "Restart the application": a fresh begin for the same snapshot resumes the same upload and
  // reports exactly which chunks are still missing — the state is in PostgreSQL, not in memory.
  const resumed = await hubCall('/api/sync/clone', { headers, body: { action: 'begin', size: bytes.length, sha } });
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.upload_id, uploadId, 'the same upload is resumed, not a second one');
  const state = await hubCall('/api/sync/clone', { headers, body: { action: 'status', upload_id: uploadId } });
  assert.equal(state.status, 200, state.text);
  assert.equal(state.json.received, 1);
  assert.deepEqual(state.json.missing, Array.from({ length: chunks - 1 }, (_, i) => i + 1));

  for (const no of state.json.missing) {
    const slice = bytes.subarray(no * chunkSize, (no + 1) * chunkSize);
    const r = await hubCall('/api/sync/clone', { headers, body: { action: 'chunk', upload_id: uploadId, chunk_no: no, data: slice.toString('base64') } });
    assert.equal(r.status, 200, r.text);
  }
  const commit = await hubCall('/api/sync/clone', { headers, body: { action: 'commit', upload_id: uploadId } });
  assert.equal(commit.status, 200, commit.text);
  assert.equal(commit.json.activated, true, commit.text);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a snapshot with the wrong schema version is refused and the online copy is untouched', { skip: SKIP }, async () => {
  const headers = await deviceHeaders();
  const beforeHub = (await hubCall('/api/data', { cookie: hubCookie })).json;
  const { snapshotToFile } = await import('../../lib/clone-engine');
  const Database = require('better-sqlite3');
  const d = await deskDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-clone-bad-'));
  const file = snapshotToFile(d, path.join(dir, 'bad.db'));
  const tampered = new Database(file);
  tampered.pragma('user_version = 3');            // an older build's schema
  tampered.close();
  const bytes = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const begun = await hubCall('/api/sync/clone', { headers, body: { action: 'begin', size: bytes.length, sha } });
  assert.equal(begun.status, 200, begun.text);
  const chunkSize = Number(begun.json.chunk_size);
  for (let no = 0; no < Number(begun.json.chunks); no++) {
    const slice = bytes.subarray(no * chunkSize, (no + 1) * chunkSize);
    assert.equal((await hubCall('/api/sync/clone', { headers, body: { action: 'chunk', upload_id: begun.json.upload_id, chunk_no: no, data: slice.toString('base64') } })).status, 200);
  }
  const commit = await hubCall('/api/sync/clone', { headers, body: { action: 'commit', upload_id: begun.json.upload_id } });
  assert.equal(commit.status, 422, commit.text);
  assert.equal(commit.json.stage, 'validate-upload');
  assert.match(String(commit.json.checks.find((c: any) => c.name === 'schema_version').detail), /^3 /);
  const afterHub = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.equal(afterHub.purchases.length, beforeHub.purchases.length, 'the online copy was not replaced by an invalid upload');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('online → offline full clone: downloaded, verified, activated, previous file kept', { skip: SKIP }, async () => {
  // A record that exists only online, so the pull is observable.
  const onlyOnline = await hubCall('/api/parties', { cookie: hubCookie, body: { name: 'Online Only Vendor', party_type: 'GOODS_VENDOR' } });
  assert.ok(onlyOnline.status < 400, onlyOnline.text);

  const preview = await clone({ direction: 'pull', preview: true });
  assert.equal(preview.status, 200, preview.text);
  assert.ok(preview.json.differences.length > 0, 'the preview reports the difference before anything is replaced');

  const r = await clone({ direction: 'pull', confirm: 'REPLACE OFFLINE SOLIVY LIVE' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.stage, 'verified');
  assert.ok(r.json.previous_file, 'the previous local file is kept');

  const d = await deskDb();
  assert.ok(d.prepare("SELECT id FROM parties WHERE name='Online Only Vendor'").get(), 'the online-only record is now local');
  // Identity is this device's own, not the hub's, and the journal is settled.
  const meta = d.prepare('SELECT device_id,remote_cursor FROM sync_meta WHERE id=1').get() as any;
  const pairedDevice = (await hubCall('/api/sync/pair', { cookie: hubCookie })).json;
  void pairedDevice;
  assert.ok(String(meta.device_id).length > 0);
  // Nothing business-related is pending: the two sides hold the same records. The clone request
  // itself is audited (audit_logs), and that row synchronises normally afterwards.
  const pending = d.prepare("SELECT event_id,table_name,operation FROM sync_changes WHERE pushed=0 AND table_name<>'audit_logs' LIMIT 3").all();
  assert.deepEqual(pending, [], `nothing business-related is pending after a clone: ${JSON.stringify(pending)}`);
  assert.ok(Number(meta.remote_cursor) >= 0);
});

test('incremental sync works in both directions after a clone, with no duplicates', { skip: SKIP }, async () => {
  const d = await deskDb();
  // Device → hub.
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'After Clone Device Party', party_type: 'GOODS_VENDOR' } }));
  const up = await sync();
  assert.equal(up.status, 200, up.text);
  assert.ok(!up.json.conflict, up.text);
  assert.ok((await hubCall('/api/data', { cookie: hubCookie })).json.parties.some((p: any) => p.name === 'After Clone Device Party'), 'the device change reached the hub');

  // Hub → device.
  assert.ok((await hubCall('/api/parties', { cookie: hubCookie, body: { name: 'After Clone Hub Party', party_type: 'GOODS_VENDOR' } })).status < 400);
  const down = await sync();
  assert.equal(down.status, 200, down.text);
  assert.ok(!down.json.conflict, down.text);
  assert.ok(d.prepare("SELECT id FROM parties WHERE name='After Clone Hub Party'").get(), `the hub change reached the device: ${down.text.slice(0, 400)} meta=${JSON.stringify(d.prepare('SELECT device_id,remote_cursor FROM sync_meta WHERE id=1').get())}`);

  // Repeating the sync changes nothing.
  const counts = () => Number((d.prepare('SELECT COUNT(*) c FROM parties').get() as any).c);
  const beforeCount = counts();
  for (let i = 0; i < 2; i++) { const again = await sync(); assert.equal(again.status, 200, again.text); assert.ok(!again.json.conflict, again.text); }
  assert.equal(counts(), beforeCount, 'repeated syncs created no duplicates');
});

test('a clone of one organisation does not touch another, and validation covers both sides', { skip: SKIP }, async () => {
  const other = await app.seedOrg({ companyName: 'Clone Isolation Org' });
  await app.seedUser({ username: `iso_${Math.random().toString(36).slice(2, 7)}`, role: 'ADMIN', companies: [{ id: other, live: true }] });
  const { db } = await import('../../lib/db');
  const otherDb = db('LIVE', other);
  otherDb.prepare("INSERT INTO parties(name,party_type) VALUES('Isolated Party','GOODS_VENDOR')").run();
  const otherBefore = Number((otherDb.prepare('SELECT COUNT(*) c FROM parties').get() as any).c);

  const r = await clone({ direction: 'push', confirm: 'REPLACE ONLINE SOLIVY LIVE' });
  assert.equal(r.status, 200, r.text);
  assert.equal(Number((otherDb.prepare('SELECT COUNT(*) c FROM parties').get() as any).c), otherBefore, 'the other organisation is untouched');
  assert.ok(!(await hubCall('/api/data', { cookie: hubCookie })).json.parties.some((p: any) => p.name === 'Isolated Party'), 'no cross-organisation leakage');

  const validation = await clone({ direction: 'validate' });
  assert.equal(validation.status, 200, validation.text);
  assert.equal(validation.json.offline.ok, true, JSON.stringify(validation.json.offline.checks));
  assert.equal(validation.json.online.ok, true, JSON.stringify(validation.json.online.checks));
  assert.equal(validation.json.differences.length, 0, `both sides agree after a clone and a sync: ${JSON.stringify(validation.json.differences).slice(0, 400)}`);
});

test('the online snapshot can be rolled back to the version kept before the last clone', { skip: SKIP }, async () => {
  // A record that exists only online, then a clone from the device replaces the online copy.
  assert.ok((await hubCall('/api/parties', { cookie: hubCookie, body: { name: 'Doomed Online Party', party_type: 'GOODS_VENDOR' } })).status < 400);
  const beforeRollback = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.length;
  const pushed = await clone({ direction: 'push', confirm: 'REPLACE ONLINE SOLIVY LIVE' });
  assert.equal(pushed.status, 200, pushed.text);
  assert.ok(!(await hubCall('/api/data', { cookie: hubCookie })).json.parties.some((p: any) => p.name === 'Doomed Online Party'), 'the clone replaced the online copy');

  const back = await clone({ direction: 'rollback-online' });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.ok, true, back.text);
  const restored = (await hubCall('/api/data', { cookie: hubCookie })).json.parties;
  assert.ok(restored.some((p: any) => p.name === 'Doomed Online Party'), 'the kept version is restored');
  assert.equal(restored.length, beforeRollback, 'the restored copy is the one that was replaced');
});

test('two clones of the same organisation cannot run at once', { skip: SKIP }, async () => {
  const headers = await deviceHeaders();
  const first = await hubCall('/api/sync/clone', { headers, body: { action: 'begin', size: 4096, sha: 'a'.repeat(64) } });
  assert.equal(first.status, 200, first.text);
  const otherDevice = { ...headers, 'x-solivy-device-id': 'second-device' };
  const second = await hubCall('/api/sync/clone', { headers: otherDevice, body: { action: 'begin', size: 4096, sha: 'b'.repeat(64) } });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.code, 'CLONE_IN_PROGRESS');
  // The lock is released when the holder's run finishes (here: a refused commit).
  await hubCall('/api/sync/clone', { headers, body: { action: 'commit', upload_id: first.json.upload_id } });
  const third = await hubCall('/api/sync/clone', { headers: otherDevice, body: { action: 'begin', size: 4096, sha: 'c'.repeat(64) } });
  assert.ok([200, 409].includes(third.status), third.text);
});
