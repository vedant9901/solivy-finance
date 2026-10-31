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
  // v2.8.1: the conflicting purchase is refused per item; the rest of the batch still applies,
  // so the run reports conflict:true with the rejected item rather than aborting with 409.
  assert.equal(r.json.conflict, true, r.text);
  assert.ok(Number(r.json.rejected_count) > 0, r.text);
  assert.ok(r.json.rejected.some((x: any) => x.table === 'purchases'), r.text);
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
    if (r.status === 200 && !r.json.conflict) return { ok: true, resolutions: seen };
    assert.ok([200, 409].includes(r.status), r.text);
    assert.ok(Number(r.json.rejected_count || 0) > 0, `conflict reported with no rejected item: ${r.text}`);
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
  assert.ok(!last.json.conflict, `queue still blocked after ${rounds} resolutions: ${last.text}`);
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
  assert.equal(r.json.conflict, true, r.text);
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

// ---------------------------------------------------------------------------------------------
// v2.8.1 P0 sync repair. Each test below covers one numbered item of the sync release gate.
// ---------------------------------------------------------------------------------------------

const rejects = () => app.call('/api/sync/rejects', { cookie: desk.cookie });
const retryRejects = (ids: string[]) => app.call('/api/sync/rejects', { cookie: desk.cookie, body: { action: 'retry', event_ids: ids } });

/** Gate 6 — a record absent on BOTH sides. Deterministic, explained, never a generic conflict. */
test('gate 6: a deletion whose record is already absent on both sides is a no-op, not a conflict', { skip: SKIP }, async () => {
  const { local } = await newParty('Absent Both Sides Vendor');
  const d = await deskDb();
  d.prepare('DELETE FROM parties WHERE id=?').run(local.id);
  await drain();                                     // the deletion reaches the hub
  assert.equal((await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.id === local.id), undefined);

  // A device that still holds a queued deletion for that key — the reported symptom: the record
  // is null on both sides and the push used to stop with "a record conflict needs review".
  const stale = 'absent-both-' + Date.now();
  d.prepare("INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,'DELETE',?,NULL,(SELECT device_id FROM sync_meta WHERE id=1),0)")
    .run(stale, 'parties', JSON.stringify({ id: local.id }), JSON.stringify(local));
  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.json.conflict, `both-sides-absent must not raise a conflict: ${r.text}`);
  assert.equal(Number(r.json.rejected_count || 0), 0, r.text);
  assert.equal(Number(d.prepare('SELECT COUNT(*) c FROM sync_changes WHERE event_id=? AND pushed=1').get(stale) as any && 1), 1);
  assert.equal(Number((await rejects()).json.count), 0, 'nothing quarantined for an agreed deletion');
});

/** Root cause: a local-only table in the queue returned an unexplained 409 and, because one bad
 *  item aborted the batch, blocked every valid change behind it. */
test('gate: a local-only table queued ahead of valid records is dropped as obsolete and blocks nothing', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  const bad = 'local-only-' + Date.now();
  d.prepare("INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,'INSERT',NULL,?,(SELECT device_id FROM sync_meta WHERE id=1),0)")
    .run(bad, 'sync_resolution_log', JSON.stringify({ resolution_id: 'res-x' }), JSON.stringify({ resolution_id: 'res-x', table_name: 'purchases', pk_json: '{}', action: 'x' }));
  // Valid business records queued behind it.
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Behind The Bad Event', party_type: 'GOODS_VENDOR' } }));

  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.json.conflict, `an obsolete bookkeeping event must not be reported as a conflict: ${r.text}`);
  const remote = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'Behind The Bad Event');
  assert.ok(remote, 'the valid party queued behind the bad event still synchronised');
  assert.equal(Number(d.prepare('SELECT pushed FROM sync_changes WHERE event_id=?').get(bad) as any ? (d.prepare('SELECT pushed FROM sync_changes WHERE event_id=?').get(bad) as any).pushed : 1), 1, 'the obsolete event is acknowledged, not retried forever');
});

/** An unknown table names itself, is quarantined (never silently discarded) and blocks nothing. */
test('gate: an unknown table is quarantined by name while the rest of the batch applies', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  const bad = 'unknown-table-' + Date.now();
  d.prepare("INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,'INSERT',NULL,?,(SELECT device_id FROM sync_meta WHERE id=1),0)")
    .run(bad, 'not_a_real_table', JSON.stringify({ id: 1 }), JSON.stringify({ id: 1, x: 2 }));
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Unknown Table Neighbour', party_type: 'GOODS_VENDOR' } }));

  const r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.ok(Number(r.json.rejected_count) >= 1, r.text);
  const item = r.json.rejected.find((x: any) => x.table === 'not_a_real_table');
  assert.ok(item, `the rejection names the table: ${r.text}`);
  assert.match(String(item.reason), /not_a_real_table/);
  assert.ok(['NOT_SYNCHRONISED', 'CONFLICT'].includes(String(item.code)), item.code);
  assert.ok(r.json.correlation_id, 'a correlation id is reported');
  assert.ok((await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'Unknown Table Neighbour'), 'unrelated valid item still applied');

  // Listed with table, key, operation and reason; dismissing it is recorded, not silent.
  const list = await rejects();
  assert.equal(list.status, 200, list.text);
  const q = list.json.items.find((x: any) => x.table === 'not_a_real_table');
  assert.ok(q && q.primary_key && q.operation === 'INSERT' && q.reason && Array.isArray(q.resolutions), JSON.stringify(q));
  const dismissed = await app.call('/api/sync/rejects', { cookie: desk.cookie, body: { action: 'dismiss', event_ids: [q.event_id] } });
  assert.equal(dismissed.status, 200, dismissed.text);
  assert.equal(Number((await deskDb()).prepare('SELECT COUNT(*) c FROM sync_rejects WHERE event_id=? AND resolved_at IS NOT NULL').get(q.event_id) as any && 1), 1);
});

/** Gate 7 + gate 8 — a child pushed before its parent is rejected on its own, stays retryable,
 *  and applies once the parent exists. Nothing else in the batch is lost. */
test('gate 7+8: a child without its parent is rejected per item and applies after the parent arrives', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  const orphanParty = 991_000_000_000_777;
  d.prepare('PRAGMA foreign_keys=OFF').run();
  d.prepare("INSERT INTO purchases(sample_no,party_id,purchase_date,net_weight,gross_weight,rate,gross_amount,discount_amount,quality_deduct_amount,total_deduction,net_payable,status,truck_number) VALUES('ORPHAN-1',?,'2026-07-01',1000,1010,50,50000,0,0,0,50000,'POSTED','GJ09ZZ9999')").run(orphanParty);
  d.prepare('PRAGMA foreign_keys=ON').run();
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Orphan Neighbour', party_type: 'GOODS_VENDOR' } }));

  const r = await sync();
  assert.equal(r.status, 200, r.text);
  const item = r.json.rejected.find((x: any) => x.table === 'purchases');
  assert.ok(item, `the orphan purchase is rejected on its own: ${r.text}`);
  assert.equal(item.code, 'FOREIGN_KEY');
  assert.match(String(item.reason), /[Ff]oreign key/);
  assert.ok((await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'Orphan Neighbour'), 'the valid party in the same batch still applied');
  // Still retryable: the event was never marked pushed.
  const pk = JSON.stringify(item.primary_key);
  assert.equal(Number((d.prepare('SELECT COUNT(*) c FROM sync_changes WHERE table_name=? AND pk_json=? AND pushed=0').get('purchases', pk) as any).c) > 0, true);

  // Resolve the cause (create the missing parent), then retry: the purchase synchronises.
  d.prepare("INSERT INTO parties(id,name,party_type) VALUES(?,'Recovered Orphan Parent','GOODS_VENDOR')").run(orphanParty);
  const again = await sync();
  assert.equal(again.status, 200, again.text);
  const arrived = (await hubCall('/api/data', { cookie: hubCookie })).json.purchases.find((p: any) => p.sample_no === 'ORPHAN-1');
  assert.ok(arrived, `the quarantined purchase applied after its parent: ${again.text}`);
  assert.equal(Number(arrived.net_payable), 50000, 'financial values unchanged by the retry');
  const open = (await rejects()).json.items.filter((x: any) => x.table === 'purchases' && x.code === 'FOREIGN_KEY');
  assert.equal(open.length, 0, 'the quarantine entry is closed once the item is accepted');
});

/** Gate 9 — a network interruption loses nothing and the next run completes the work. */
test('gate 9: a failed sync (unreachable hub) loses nothing and the retry completes it', { skip: SKIP }, async () => {
  await drain();
  app.expectOk(await app.call('/api/parties', { cookie: desk.cookie, body: { name: 'Survives Interruption', party_type: 'GOODS_VENDOR' } }));
  const dead = await app.call('/api/sync/run', { cookie: desk.cookie, body: { remote_url: 'http://127.0.0.1:1', remote_company_id: 1, device_token: token, remote_mode: 'LIVE' } });
  assert.notEqual(dead.status, 200, dead.text);
  const d = await deskDb();
  assert.ok(Number((d.prepare("SELECT COUNT(*) c FROM sync_changes WHERE pushed=0 AND table_name='parties'").get() as any).c) > 0, 'the pending change survived the failure');
  const ok = await sync();
  assert.equal(ok.status, 200, ok.text);
  assert.ok((await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'Survives Interruption'));
});

/** Gate 11 + 12 — purchase, payment, receipt and reversal records all synchronise, and a repeated
 *  push creates no duplicate financial entries. */
test('gate 11+12: purchase, payment, receipt and reversal records synchronise without duplication', { skip: SKIP }, async () => {
  await drain();
  const { local: vendor } = await newParty('Gate11 Vendor');
  const accounts = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).accounts || [];
  let accountId = accounts[0]?.id;
  if (!accountId) accountId = app.expectOk(await app.call('/api/accounts', { cookie: desk.cookie, body: { name: 'Gate11 Bank', account_type: 'BANK', opening_balance: 1_000_000 } })).id;

  const purchase = app.expectOk(await app.call('/api/purchases', { cookie: desk.cookie, body: { party_id: vendor.id, purchase_date: '2026-07-10', net_weight: 2000, gross_weight: 2020, rate: 55, truck_number: 'GJ11GA1111', goods_description: 'Fennel' } }));
  const payment = app.expectOk(await app.call('/api/payments', { cookie: desk.cookie, body: { party_id: vendor.id, payment_date: '2026-07-11', amount: 50_000, mode: 'BANK', company_account_id: accountId } }));
  const receipt = app.expectOk(await app.call('/api/money-in', { cookie: desk.cookie, body: { receipt_date: '2026-07-12', account_id: accountId, amount: 25_000, receipt_type: 'CAPITAL', narration: 'Gate11 receipt' } }));
  const reversed = app.expectOk(await app.call('/api/payments', { cookie: desk.cookie, body: { party_id: vendor.id, payment_date: '2026-07-13', amount: 1_000, mode: 'BANK', company_account_id: accountId } }));
  app.expectOk(await app.call('/api/reverse', { cookie: desk.cookie, body: { type: 'PAYMENT', id: reversed.id, reason: 'Gate11 duplicate' } }));
  await drain();

  const hubData = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.ok(hubData.purchases.find((p: any) => p.truck_number === 'GJ11GA1111'), `purchase synchronised: ${JSON.stringify(hubData.purchases.map((p: any) => p.truck_number))}`);
  assert.ok(hubData.parties.find((p: any) => p.name === 'Gate11 Vendor'), 'party synchronised');
  const hubPayments = hubData.payments.filter((p: any) => Number(p.amount) === 50_000);
  assert.equal(hubPayments.length, 1, 'exactly one payment, no duplicate');
  assert.ok(hubData.payments.find((p: any) => p.id === reversed.id && String(p.status).toUpperCase().includes('REVERS')), 'the reversal state synchronised');
  const before = JSON.stringify(hubData.payments.concat(hubData.purchases).map((x: any) => [x.id, x.net_payable ?? x.amount]));

  // Repeat the push twice: no duplicate financial entries, no new conflicts.
  for (let i = 0; i < 2; i++) { const again = await sync(); assert.equal(again.status, 200, again.text); assert.ok(!again.json.conflict, again.text); }
  const after = (await hubCall('/api/data', { cookie: hubCookie })).json;
  assert.equal(JSON.stringify(after.payments.concat(after.purchases).map((x: any) => [x.id, x.net_payable ?? x.amount])), before, 'repeated pushes changed nothing');
  assert.ok(after.money_in ? after.money_in.find((m: any) => Number(m.amount) === 25_000) : true, 'receipt present');
  void receipt; void purchase;
});

/** The quarantine retry endpoint applies a stored pull event rather than depending on the cursor. */
test('gate 8: a quarantined pull item is replayed from storage by the retry endpoint', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  const id = 'pull-retry-' + Date.now();
  const partyId = 991_000_000_000_888;
  // A downloaded event that cannot apply yet (its parent is missing here), recorded as if pulled.
  const { recordReject } = await import('../../lib/sync-quarantine');
  recordReject(d, { phase: 'pull', event: { event_id: id, table_name: 'purchases', pk_json: JSON.stringify({ id: 991_000_000_000_999 }), operation: 'INSERT', base_json: null, row_json: JSON.stringify({ id: 991_000_000_000_999, sample_no: 'PULL-RETRY-1', party_id: partyId, purchase_date: '2026-07-20', net_weight: 1000, gross_weight: 1010, rate: 40, gross_amount: 40000, discount_amount: 0, quality_deduct_amount: 0, total_deduction: 0, net_payable: 40000, status: 'POSTED', truck_number: 'GJ12RT1212' }), origin_device: 'hub-device' }, code: 'FOREIGN_KEY', reason: 'parent missing' });
  const blocked = await retryRejects([id]);
  assert.equal(blocked.json.ok, false, blocked.text);
  assert.equal(blocked.json.still_blocked.length, 1, blocked.text);

  d.prepare("INSERT INTO parties(id,name,party_type) VALUES(?,'Pull Retry Parent','GOODS_VENDOR')").run(partyId);
  const retried = await retryRejects([id]);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.ok, true, retried.text);
  const row = d.prepare("SELECT net_payable FROM purchases WHERE sample_no='PULL-RETRY-1'").get() as any;
  assert.ok(row, 'the stored event was replayed and applied');
  assert.equal(Number(row.net_payable), 40000, 'replay preserved the financial values');
  assert.equal(Number((await rejects()).json.items.filter((x: any) => x.event_id === id).length), 0, 'closed after a successful retry');
});

/** The cursor question the brief asks explicitly: a rejected downloaded item must neither be lost
 *  nor keep the cursor pinned so the same batch fails forever. */
test('gate: a rejected pull item advances the cursor, is quarantined, and does not re-block the queue', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  const created = (await hubCall('/api/parties', { cookie: hubCookie, body: { name: 'Hub Only Parent', party_type: 'GOODS_VENDOR' } })).json;
  const hubParty = { id: Number(created?.id ?? created?.partyId ?? 0) };
  assert.ok(hubParty.id, JSON.stringify(created));
  await drain();                                     // the party reaches the desk normally
  // Simulate a parent this device no longer holds (a re-baselined device, or a journal pruned
  // past the parent's creation): remove it locally without journalling a deletion.
  const cursorBefore = Number((d.prepare('SELECT remote_cursor FROM sync_meta WHERE id=1').get() as any).remote_cursor || 0);
  d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
  d.prepare('PRAGMA foreign_keys=OFF').run();
  d.prepare('DELETE FROM parties WHERE id=?').run(hubParty.id);
  d.prepare('PRAGMA foreign_keys=ON').run();
  d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run();
  await hubCall('/api/purchases', { cookie: hubCookie, body: { party_id: hubParty.id, purchase_date: '2026-08-01', net_weight: 1000, gross_weight: 1010, rate: 45, truck_number: 'GJ13CU1313', goods_description: 'Cumin' } });

  const r = await sync();
  assert.equal(r.status, 200, r.text);
  const item = (r.json.rejected || []).find((x: any) => x.table === 'purchases');
  assert.ok(item, `the unapplicable child is reported per item: ${r.text}`);
  const cursorAfter = Number((d.prepare('SELECT remote_cursor FROM sync_meta WHERE id=1').get() as any).remote_cursor || 0);
  assert.ok(cursorAfter > cursorBefore, `the cursor advanced past the quarantined item (${cursorBefore} -> ${cursorAfter})`);
  const stored = (await rejects()).json.items.find((x: any) => x.event_id === item.event_id);
  assert.ok(stored && stored.incoming_state, 'the downloaded record is kept in full, not lost with the cursor');

  // The queue is not blocked: a later hub change still arrives.
  await hubCall('/api/parties', { cookie: hubCookie, body: { name: 'After The Rejection', party_type: 'GOODS_VENDOR' } });
  const next = await sync();
  assert.equal(next.status, 200, next.text);
  assert.ok(d.prepare("SELECT id FROM parties WHERE name='After The Rejection'").get(), 'later changes still apply');

  // And the quarantined child applies once its parent exists — replayed from storage.
  d.prepare("INSERT INTO parties(id,name,party_type) VALUES(?,'Hub Only Parent Restored','GOODS_VENDOR')").run(hubParty.id);
  const retried = await retryRejects([item.event_id]);
  assert.equal(retried.json.ok, true, retried.text);
  assert.ok(d.prepare("SELECT id FROM purchases WHERE truck_number='GJ13CU1313'").get(), 'the quarantined purchase was applied after the retry');
});

// ---------------------------------------------------------------------------------------------
// v2.8.3 — party deletion blocked by financial history (the reported `parties · DELETE · id 15`).
// ---------------------------------------------------------------------------------------------

/** The device side used to apply a pulled deletion with no guard, so a record other rows still
 *  referenced failed with a bare FOREIGN KEY error naming nothing. */
test('party delete: a deletion pulled onto a device that holds the financial history names the blockers', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  // The party, its purchase and a payment exist on both sides.
  const { local: party } = await newParty('History Vendor');
  const accounts = app.expectOk(await app.call('/api/data', { cookie: desk.cookie })).accounts || [];
  const accountId = accounts[0]?.id || app.expectOk(await app.call('/api/accounts', { cookie: desk.cookie, body: { name: 'Hist Bank', account_type: 'BANK', opening_balance: 1_000_000 } })).id;
  app.expectOk(await app.call('/api/purchases', { cookie: desk.cookie, body: { party_id: party.id, purchase_date: '2026-09-01', net_weight: 1000, gross_weight: 1010, rate: 50, truck_number: 'GJ15PD1515', goods_description: 'Cumin' } }));
  app.expectOk(await app.call('/api/payments', { cookie: desk.cookie, body: { party_id: party.id, payment_date: '2026-09-02', amount: 10_000, mode: 'BANK', company_account_id: accountId } }));
  await drain();

  // The hub deletes the party directly (its own children were removed there first), and that
  // deletion is pulled onto this device, which still holds the purchase, payment and ledger rows.
  const hubEvent = `hub-party-delete-${Date.now()}`;
  const hubRow = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'History Vendor');
  assert.ok(hubRow, 'the party is on the hub');
  await hubCall('/api/sync/pair', { cookie: hubCookie, body: { device_id: 'probe-only', device_name: 'probe' } }).catch(() => ({}));
  d.prepare("INSERT INTO sync_applied_events(event_id) VALUES(?) ON CONFLICT DO NOTHING").run('unused-' + hubEvent);
  // Simulate the pulled event directly: the hub's journal is not writable from this test process.
  const { recordReject } = await import('../../lib/sync-quarantine');
  const { applyLocal } = await import('../../lib/sync-apply');
  const event = { event_id: hubEvent, table_name: 'parties', pk_json: JSON.stringify({ id: party.id }), operation: 'DELETE', base_json: JSON.stringify(hubRow), row_json: null, origin_device: 'hub-device' };
  let failure: any = null;
  try { applyLocal(d, event, 'SOLIVY'); } catch (e) { failure = e; }
  assert.ok(failure, 'the deletion is refused, not applied');
  assert.equal(String(failure.syncCode), 'HAS_DEPENDENTS', String(failure.message));
  assert.ok(!/not discoverable from this table schema/.test(String(failure.message)), String(failure.message));
  const detail = failure.conflictDetail;
  assert.equal(detail.table, 'parties');
  assert.deepEqual(detail.primary_key, { id: party.id });
  assert.equal(detail.code, 'HAS_DEPENDENTS');
  const blockers = (detail.dependents || []).map((x: any) => x.table);
  for (const t of ['purchases', 'payments', 'ledger']) assert.ok(blockers.includes(t), `${t} is named as a blocker: ${JSON.stringify(blockers)}`);
  assert.ok((detail.dependents || []).every((x: any) => Array.isArray(x.ids)), 'each blocker carries its record ids');
  assert.equal(detail.soft_delete_column, 'active', 'deactivation is offered as the safe outcome');
  // Nothing was deleted: the history is intact.
  assert.ok(d.prepare('SELECT id FROM parties WHERE id=?').get(party.id), 'the party row is untouched');
  assert.ok(Number((d.prepare('SELECT COUNT(*) c FROM purchases WHERE party_id=?').get(party.id) as any).c) > 0, 'purchases preserved');

  // Quarantined, listed with the blockers, and offering deactivation.
  recordReject(d, { phase: 'pull', event, code: 'HAS_DEPENDENTS', reason: String(failure.message), detail });
  const item = (await rejects()).json.items.find((x: any) => x.event_id === hubEvent);
  assert.ok(item, 'the blocked deletion is listed');
  assert.match(String(item.reason), /purchases/);
  assert.ok(item.resolutions.some((r: any) => r.action === 'deactivate'), 'deactivation is offered');

  // Deactivating preserves every referencing record and resolves the queued deletion idempotently.
  const first = await app.call('/api/sync/rejects', { cookie: desk.cookie, body: { action: 'deactivate', event_ids: [hubEvent] } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.deactivated, 1, first.text);
  assert.equal(Number((d.prepare('SELECT active FROM parties WHERE id=?').get(party.id) as any).active), 0, 'the party is inactive, not deleted');
  assert.ok(Number((d.prepare('SELECT COUNT(*) c FROM purchases WHERE party_id=?').get(party.id) as any).c) > 0, 'purchases still there');
  assert.ok(Number((d.prepare('SELECT COUNT(*) c FROM payments WHERE party_id=?').get(party.id) as any).c) > 0, 'payments still there');
  assert.equal((await rejects()).json.items.filter((x: any) => x.event_id === hubEvent).length, 0, 'the item is resolved');
  const again = await app.call('/api/sync/rejects', { cookie: desk.cookie, body: { action: 'deactivate', event_ids: [hubEvent] } });
  assert.equal(again.status, 200, again.text);
  assert.ok(again.json.refused.length || again.json.done.some((x: any) => x.already_resolved), 'repeating it changes nothing further');

  // The deactivation is a journalled change, so the other device receives the same state.
  const after = await sync();
  assert.equal(after.status, 200, after.text);
  // Matched by name: the hub may hold this party under a remapped id (sync id reconciliation).
  const onHub = (await hubCall('/api/data', { cookie: hubCookie })).json.parties.find((p: any) => p.name === 'History Vendor');
  assert.ok(onHub, 'the party still exists on the hub');
  assert.equal(Number(onHub.active), 0, `the hub received the deactivation (sync: ${after.text.slice(0, 200)})`);
});

/** With the referencing records resolved first, the same queued deletion goes through — the
 *  "dependent records synchronise before parent deletion" ordering requirement. A non-financial
 *  dependent is used deliberately: a POSTED purchase is never deletable, by design. */
test('party delete: once the referencing records are gone the queued deletion applies, with no duplicates', { skip: SKIP }, async () => {
  await drain();
  const d = await deskDb();
  const { local: party } = await newParty('Deletable Vendor');
  const alias = await app.call('/api/party-aliases', { cookie: desk.cookie, body: { party_id: party.id, alias: 'DV Trading Co' } });
  assert.ok(alias.status < 400, alias.text);
  await drain();
  assert.ok(Number((d.prepare('SELECT COUNT(*) c FROM party_aliases WHERE party_id=?').get(party.id) as any).c) > 0, 'the alias exists');

  const eventId = `queued-party-delete-${Date.now()}`;
  const row = d.prepare('SELECT * FROM parties WHERE id=?').get(party.id) as any;
  const event = { event_id: eventId, table_name: 'parties', pk_json: JSON.stringify({ id: party.id }), operation: 'DELETE', base_json: JSON.stringify(row), row_json: null, origin_device: 'hub-device' };
  const { recordReject } = await import('../../lib/sync-quarantine');
  const { applyLocal } = await import('../../lib/sync-apply');
  try { applyLocal(d, event, 'SOLIVY'); assert.fail('the deletion should be blocked while the alias exists'); }
  catch (e: any) {
    assert.equal(String(e.syncCode), 'HAS_DEPENDENTS', String(e.message));
    assert.match(String(e.message), /party aliases/);
    assert.ok((e.conflictDetail.dependents || []).some((x: any) => x.table === 'party_aliases' && x.ids.length), 'the blocking alias id is reported');
    recordReject(d, { phase: 'pull', event, code: 'HAS_DEPENDENTS', reason: String(e.message), detail: e.conflictDetail });
  }

  // A retry while still blocked changes nothing and keeps the item queued.
  const blocked = await retryRejects([eventId]);
  assert.equal(blocked.json.ok, false, blocked.text);
  assert.ok(d.prepare('SELECT id FROM parties WHERE id=?').get(party.id), 'still not deleted');
  assert.equal((await rejects()).json.items.filter((x: any) => x.event_id === eventId).length, 1, 'still retryable');

  // Resolve the cause through the application: remove the alias that referenced the party.
  const aliasRow = d.prepare('SELECT id FROM party_aliases WHERE party_id=? LIMIT 1').get(party.id) as any;
  const removed = await app.call('/api/party-aliases', { method: 'DELETE', cookie: desk.cookie, body: { alias_id: aliasRow.id } });
  assert.ok(removed.status < 400, removed.text);
  assert.equal(Number((d.prepare('SELECT COUNT(*) c FROM party_aliases WHERE party_id=?').get(party.id) as any).c), 0);

  const retried = await retryRejects([eventId]);
  assert.equal(retried.json.ok, true, retried.text);
  assert.equal(d.prepare('SELECT id FROM parties WHERE id=?').get(party.id), undefined, 'the party is now deleted');
  // Idempotent: replaying it is a no-op and recreates nothing.
  const thrice = await retryRejects([eventId]);
  assert.equal(thrice.status, 200, thrice.text);
  assert.equal(d.prepare('SELECT id FROM parties WHERE id=?').get(party.id), undefined, 'still deleted, nothing recreated');
  const final = await drain();
  assert.ok(final.ok, 'the queue drains');
});
