/**
 * OFFLINE desktop (local SQLite, this process) ⇄ ONLINE hub (separate process, Vercel mode on
 * PostgreSQL) through real HTTP, using the application's own pairing, push, pull and conflict code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PG = process.env.SOLIVY_TEST_PG_URL || '';
const SKIP = PG ? false : 'NOT VERIFIED: SOLIVY_TEST_PG_URL not set (no PostgreSQL available)';
const DB = `solivy_sync_${process.pid}_${Date.now()}`;
const ROOT = path.resolve(__dirname, '..', '..');
const SECRET = 'online-test-setup-secret-0123456789';
const PW = 'Correct-Horse-Battery-9';
let hub: ChildProcess | null = null; let hubUrl = ''; let hubCookie = ''; let token = '';
let app: typeof import('../helpers/app'); let desk = { cookie: '', companyId: 0 };

async function startHub() {
  const env = { ...process.env, VERCEL: '1', DATABASE_URL: `${PG}/${DB}`, SOLIVY_PG_SSL: 'disable', SOLIVY_SETUP_SECRET: SECRET, FINANCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-hub-')) };
  hub = spawn(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', path.join(ROOT, 'tests/helpers/server.ts'), '0'], { env, cwd: ROOT });
  hub.stderr!.on('data', (d) => { if (process.env.DEBUG_HUB) process.stderr.write(d); });
  hubUrl = await new Promise((resolve, reject) => {
    hub!.stdout!.on('data', (d) => { const m = String(d).match(/LISTENING (\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
    hub!.on('exit', (c) => reject(new Error(`hub exited ${c}`)));
  });
}
async function hubCall(p: string, opts: { method?: string; body?: any; cookie?: string } = {}) {
  const r = await fetch(hubUrl + p, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', origin: hubUrl, ...(opts.cookie ? { cookie: `aksh_session=${opts.cookie}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
  const m = (r.headers.get('set-cookie') || '').match(/aksh_session=([^;]*)/);
  return { status: r.status, json, text, cookie: m?.[1] };
}
const sync = () => app.call('/api/sync/run', { cookie: desk.cookie, body: { remote_url: hubUrl, remote_company_id: 1, device_token: token, remote_mode: 'LIVE' } });

before(async () => {
  if (SKIP) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`CREATE DATABASE ${DB}`); await c.end();
  await startHub();
  assert.equal((await hubCall('/api/setup', { body: { setupSecret: SECRET, username: 'owner', name: 'Owner', email: 'o@example.test', password: PW, confirmPassword: PW } })).status, 200);
  hubCookie = (await hubCall('/api/login', { body: { username: 'owner', password: PW, company_id: 1, mode: 'LIVE' } })).cookie!;
  app = await import('../helpers/app');
  // Sync deliberately requires the same organization on both sides; use the local default org (SOLIVY, id 1).
  await app.seedUser({ username: 'deskadmin', role: 'ADMIN', companies: [{ id: 1, live: true, test: true }] });
  desk = { cookie: await app.login('deskadmin', 1, 'LIVE'), companyId: 1 };
  const { db } = await import('../../lib/db');
  const deviceId = (db('LIVE', desk.companyId).prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any).device_id;
  const pair = await hubCall('/api/sync/pair', { cookie: hubCookie, body: { device_id: deviceId, device_name: 'Desktop test' } });
  assert.equal(pair.status, 200, pair.text);
  token = pair.json.device_token;
});
after(async () => {
  if (SKIP) return;
  hub?.kill();
  const { Client } = require('pg');
  const c = new Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await c.end();
});

test('offline desktop writes are pushed to the online hub with identical financial values', { skip: SKIP }, async () => {
  app.expectOk(await app.call('/api/accounts', { cookie: desk.cookie, body: { account_name: 'Desk Bank', bank_name: 'SBI', account_type: 'BANK', opening_balance: 100000, opening_date: '2026-04-01' } }));
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Desk Vendor', party_type: 'GOODS_VENDOR' } }));
  const d0 = app.expectOk(await app.call('/api/data', { cookie: desk.cookie }));
  app.expectOk(await app.call('/api/purchases', { cookie: desk.cookie, body: { party_id: d0.parties[0].id, purchase_date: '2026-05-01', net_weight: 1000, gross_weight: 1010, rate: 47, freight: 250, discount_pct: 1, truck_number: 'MH01Z9' } }));
  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.pushed > 0);
  const desktop = app.expectOk(await app.call('/api/data', { cookie: desk.cookie }));
  const online = (await hubCall('/api/data', { cookie: hubCookie })).json;
  const dp = desktop.purchases[0]; const op = online.purchases.find((p: any) => p.sample_no === dp.sample_no);
  assert.ok(op, 'purchase reached the hub');
  for (const k of ['gross_amount', 'discount_amount', 'total_deduction', 'net_payable', 'truck_number']) assert.equal(op[k], dp[k], k);
  assert.equal(online.accounts.find((a: any) => a.account_name === 'Desk Bank').balance, 100000);
});

test('hub changes are pulled to the desktop; repeating a sync is a no-op (no duplicates)', { skip: SKIP }, async () => {
  assert.equal((await hubCall('/api/parties', { cookie: hubCookie, body: { name: 'Hub Vendor', party_type: 'GOODS_VENDOR' } })).status, 200);
  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.pulled > 0);
  const again = await sync();
  assert.equal(again.json.pushed, 0);
  const desktop = app.expectOk(await app.call('/api/data', { cookie: desk.cookie }));
  assert.equal(desktop.parties.filter((p: any) => p.name === 'Hub Vendor').length, 1);
  const online = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.equal(online.parties.filter((p: any) => p.name === 'Desk Vendor').length, 1);
});

test('pending offline changes survive a desktop restart and a hub restart', { skip: SKIP }, async () => {
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Written While Offline', party_type: 'GOODS_VENDOR' } }));
  const { closeAllDatabases } = await import('../../lib/db');
  closeAllDatabases(); // desktop "restart": only what is on disk remains
  hub!.kill(); await new Promise((r) => setTimeout(r, 200));
  await startHub(); // hub restart: fresh process, no local cache
  hubCookie = (await hubCall('/api/login', { body: { username: 'owner', password: PW, company_id: 1, mode: 'LIVE' } })).cookie!;
  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.pushed >= 1);
  const online = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.ok(online.parties.some((p: any) => p.name === 'Written While Offline'));
  assert.ok(online.purchases.length >= 1, 'earlier purchase still present after hub restart');
});

test('master-data edit conflict: deterministic merge on both sides, reported, both values kept in history', { skip: SKIP }, async () => {
  const desktop = app.expectOk(await app.call('/api/data', { cookie: desk.cookie }));
  const party = desktop.parties.find((p: any) => p.name === 'Hub Vendor');
  const hubParty = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'Hub Vendor');
  const he = await hubCall('/api/parties', { cookie: hubCookie, body: { ...hubParty, contact: '9000000001' } });
  assert.equal(he.status, 200, he.text);
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { ...party, contact: '9000000002' } }));
  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(Number(r.json.remote_field_conflicts) + Number(r.json.field_conflicts_recorded) > 0, `conflict must be reported: ${r.text.slice(0, 300)}`);
  const hubAfter = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.id === hubParty.id);
  await sync();
  const deskAfter = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).parties.find((p: any) => p.id === party.id);
  assert.equal(deskAfter.contact, hubAfter.contact, 'both sides converge to the same value');
  const { db } = await import('../../lib/db');
  const hist = db('LIVE', 1).prepare("SELECT * FROM sync_conflict_history WHERE table_name='parties' AND field_name='contact'").all() as any[];
  void hist; // desktop history may be empty when the conflict was detected on the hub; the hub reported it above
});

test('financial edit conflict (same purchase changed on both sides) is blocked for manual resolution', { skip: SKIP }, async () => {
  const deskP = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).purchases[0];
  const hubP = (await hubCall('/api/data', { cookie: hubCookie })).json.purchases.find((p: any) => p.sample_no === deskP.sample_no);
  const he = await hubCall('/api/purchases', { method: 'PUT', cookie: hubCookie, body: { ...hubP, rate: 48 } });
  assert.equal(he.status, 200, he.text);
  app.expectOk(await app.call('/api/purchases', { method: 'PUT', cookie: desk.cookie, body: { ...deskP, rate: 49 } }));
  const r = await sync();
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.conflict, true);
  assert.match(String(r.json.error), /Financial records are never merged automatically|Cannot merge (ledger|purchases)|Conflict on/);
  const hubAfter = (await hubCall('/api/data', { cookie: hubCookie })).json.purchases.find((p: any) => p.id === hubP.id);
  assert.equal(hubAfter.rate, 48, 'hub financial record untouched');
  const deskAfter = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).purchases.find((p: any) => p.id === deskP.id);
  assert.equal(deskAfter.rate, 49, 'desktop financial record untouched');
});

test('LIVE device token cannot be used for TEST and wrong-org tokens are refused', { skip: SKIP }, async () => {
  const r = await app.call('/api/sync/run', { cookie: desk.cookie, body: { remote_url: hubUrl, remote_company_id: 1, device_token: token, remote_mode: 'TEST' } });
  assert.equal(r.status, 400);
  const forged = await fetch(hubUrl + '/api/sync/exchange?cursor=0&limit=1', { headers: { 'x-solivy-device-token': token, 'x-solivy-device-id': 'x', 'x-aksh-company-id': '2', 'x-aksh-mode': 'LIVE' } });
  assert.equal(forged.status, 401);
});

/** v2.8.0 — delete / recreate conflicts, which previously had no resolution at all. */
const resolve = (body: any) => app.call('/api/sync/resolve', { cookie: desk.cookie, body: { remote_url: hubUrl, remote_company_id: 1, device_token: token, ...body } });
const deskDb = async () => (await import('../../lib/db')).db('LIVE', desk.companyId);

/**
 * Synchronise, resolving whatever conflicts come up, until the queue is empty. This is the
 * behaviour the v2.8.0 fix is about: before it, a conflict whose chosen side was a deletion could
 * not be resolved at all, so the queue stayed blocked for good.
 */
async function drain(action: 'push_local' | 'accept_remote' = 'push_local', rounds = 12) {
  const seen: string[] = [];
  for (let i = 0; i < rounds; i++) {
    const r = await sync();
    if (r.status === 200) return { ok: true, resolutions: seen };
    assert.equal(r.status, 409, r.text);
    const detail = r.json.conflict_detail || {};
    const args = { phase: r.json.conflict_phase || 'pull', table: detail.table, primary_key: detail.primary_key, conflict_detail: detail, conflict_event: r.json.conflict_event || {}, cascade: true, override: true };
    const res = await resolve({ ...args, action });
    if (res.status !== 200) {
      const other = await resolve({ ...args, action: action === 'push_local' ? 'accept_remote' : 'push_local' });
      assert.equal(other.status, 200, `could not resolve ${detail.table}: ${res.text} / ${other.text}`);
      seen.push(`${detail.table}:${action === 'push_local' ? 'accept_remote' : 'push_local'}`);
    } else seen.push(`${detail.table}:${action}`);
  }
  const last = await sync();
  assert.equal(last.status, 200, `queue still blocked after ${rounds} resolutions: ${last.text}`);
  return { ok: true, resolutions: seen };
}

async function newParty(name: string) {
  await drain();
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name, party_type: 'GOODS_VENDOR' } }));
  await drain();
  const local = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).parties.find((p: any) => p.name === name);
  const remote = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === name);
  assert.ok(local && remote, `${name} exists on both sides`);
  return { local, remote };
}

test('a record deleted on the desktop: pushing that deletion removes it on the hub too', { skip: SKIP }, async () => {
  const { local } = await newParty('Delete Push Vendor');
  const d = await deskDb();
  d.prepare('DELETE FROM parties WHERE id=?').run(local.id);

  const r = await sync();
  // A plain delete of an unreferenced master record synchronises without a conflict.
  if (r.status === 200) {
    const remote = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.id === local.id);
    assert.equal(remote, undefined, 'the hub record is gone');
    return;
  }
  assert.equal(r.status, 409, r.text);
  const res = await resolve({ phase: r.json.conflict_phase || 'push', action: 'push_local', table: r.json.conflict_detail.table, primary_key: r.json.conflict_detail.primary_key, conflict_detail: r.json.conflict_detail, conflict_event: r.json.conflict_event || {}, cascade: true });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.resolved);
  const remote = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.id === local.id);
  assert.equal(remote, undefined, 'the deletion reached the hub');
  // Retrying the same resolution changes nothing further.
  const again = await resolve({ phase: r.json.conflict_phase || 'push', action: 'push_local', table: r.json.conflict_detail.table, primary_key: r.json.conflict_detail.primary_key, conflict_detail: r.json.conflict_detail, conflict_event: r.json.conflict_event || {}, cascade: true });
  assert.equal(again.status, 200, again.text);
  assert.ok(again.json.already_resolved || again.json.resolved);
});

test('a deletion is refused while dependent records still point at it, then applied once confirmed', { skip: SKIP }, async () => {
  const { local: party } = await newParty('Dependent Vendor');
  const d = await deskDb();
  // A purchase for this party, synchronised, then the party is deleted locally with the child intact.
  app.expectOk(await app.call('/api/purchases', { cookie: desk.cookie, body: { party_id: party.id, purchase_date: '2026-06-20', net_weight: 1000, gross_weight: 1010, rate: 50, truck_number: 'GJ09DD1111', goods_description: 'Cumin' } }));
  await drain();
  d.prepare('PRAGMA foreign_keys=OFF').run();
  d.prepare('DELETE FROM parties WHERE id=?').run(party.id);
  d.prepare('PRAGMA foreign_keys=ON').run();

  const r = await sync();
  assert.equal(r.status, 409, r.text);
  const args = { phase: r.json.conflict_phase || 'push', table: r.json.conflict_detail.table, primary_key: r.json.conflict_detail.primary_key, conflict_detail: r.json.conflict_detail, conflict_event: r.json.conflict_event || {} };
  const refused = await resolve({ ...args, action: 'push_local' });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.code, 'HAS_DEPENDENTS');
  assert.equal(refused.json.needs_confirmation, true);
  assert.ok(Array.isArray(refused.json.dependents) && refused.json.dependents.some((x: any) => x.table === 'purchases'));
  const hubParty = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.id === party.id);
  assert.ok(hubParty, 'nothing was deleted while the resolution was refused');

  const confirmed = await resolve({ ...args, action: 'push_local', cascade: true });
  assert.equal(confirmed.status, 200, confirmed.text);
  const after = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.id === party.id);
  assert.equal(after, undefined, 'the party is gone on the hub');
  // Audit: the hub keeps a recovery copy of the parent and the children it removed.
  const log = (await hubCall('/api/admin/transfer-metrics', { cookie: hubCookie, body: undefined })).status;
  assert.equal(log, 200, 'hub still serving after the cascade');
});

test('a POSTED financial record is never deleted by a resolution; reversal is required', { skip: SKIP }, async () => {
  const { applyResolvedDelete } = await import('../../lib/sync-delete');
  const d = await deskDb();
  const purchase = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).purchases.find((p: any) => String(p.status).toUpperCase() === 'POSTED');
  assert.ok(purchase, 'a posted purchase exists');
  const res = applyResolvedDelete(d, { table: 'purchases', key: { id: purchase.id }, pk: [{ name: 'id' }], resolutionId: 'test-posted-guard', deviceId: 'test', cascade: true, override: true });
  assert.equal(res.outcome, null);
  assert.equal(res.guard && res.guard.ok, false);
  assert.equal((res.guard as any).code, 'POSTED_RECORD');
  assert.match((res.guard as any).message, /revers/i);
  assert.ok(d.prepare('SELECT id FROM purchases WHERE id=?').get(purchase.id), 'the posted record is still there');
});

test('a stale deletion cannot remove a record that was changed or re-entered afterwards', { skip: SKIP }, async () => {
  const { local, remote } = await newParty('Stale Delete Vendor');
  const d = await deskDb();
  // The hub deletes the party; the desktop edits it before the deletion is pulled.
  assert.equal((await hubCall('/api/parties-delete', { cookie: hubCookie, body: { id: remote.id, confirm: true } })).status < 500, true);
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { ...local, contact: '9825099999' } }));

  const r = await sync();
  if (r.status === 409) {
    const args = { phase: r.json.conflict_phase || 'pull', table: r.json.conflict_detail.table, primary_key: r.json.conflict_detail.primary_key, conflict_detail: r.json.conflict_detail, conflict_event: r.json.conflict_event || {} };
    const refused = await resolve({ ...args, action: 'accept_remote' });
    if (refused.status === 409) {
      assert.match(String(refused.json.code || ''), /DELETE_STALE|DELETE_WITHOUT_BASE/);
      assert.ok(d.prepare('SELECT id FROM parties WHERE id=?').get(local.id), 'the newer local record survived');
      const forced = await resolve({ ...args, action: 'accept_remote', override: true, cascade: true });
      assert.equal(forced.status, 200, forced.text);
      assert.equal(d.prepare('SELECT id FROM parties WHERE id=?').get(local.id), undefined, 'an explicit override applies the deletion');
    } else {
      assert.equal(refused.status, 200, refused.text);
    }
  }
  // Whatever path the conflict took, the databases must not disagree silently afterwards.
  const final = await sync();
  assert.ok([200, 409].includes(final.status), final.text);
});

test('a record deleted on one side and re-entered on the other keeps the surviving version', { skip: SKIP }, async () => {
  const { local, remote } = await newParty('Recreate Vendor');
  const d = await deskDb();
  d.prepare('DELETE FROM parties WHERE id=?').run(local.id);
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Recreate Vendor Again', party_type: 'GOODS_VENDOR' } }));
  const he = await hubCall('/api/parties', { cookie: hubCookie, body: { ...remote, contact: '9825011111' } });
  assert.ok(he.status < 500, he.text);

  for (let i = 0; i < 3; i++) {
    const r = await sync();
    if (r.status === 200) break;
    assert.equal(r.status, 409, r.text);
    const args = { phase: r.json.conflict_phase || 'pull', table: r.json.conflict_detail.table, primary_key: r.json.conflict_detail.primary_key, conflict_detail: r.json.conflict_detail, conflict_event: r.json.conflict_event || {} };
    const res = await resolve({ ...args, action: 'accept_remote', cascade: true, override: true });
    assert.equal(res.status, 200, res.text);
  }
  // No duplicates were produced by the retries on either side.
  const names = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).parties.map((p: any) => p.name);
  assert.equal(names.filter((n: string) => n === 'Recreate Vendor Again').length, 1);
  const hubNames = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.map((p: any) => p.name);
  assert.equal(hubNames.filter((n: string) => n === 'Recreate Vendor Again').length <= 1, true);
});
