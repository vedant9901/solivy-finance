/**
 * v2.8.1 P0 — table eligibility, the absent-record rule and the quarantine, on real SQLite.
 *
 * These are the unit-level guarantees behind the sync repair: one eligibility rule shared by the
 * hub, the device and the trigger builder; a deterministic, explained outcome when a record is
 * absent; and a quarantine that keeps a rejected item retryable instead of losing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SYNC_EXCLUDED_TABLES, syncEligibility, syncTableInfo, isLocalOnlyTable } from '../../lib/sync-eligibility';
import { decideAbsent, tombstoneFor } from '../../lib/sync-absent';
import { recordReject, openRejects, clearReject, rejectedEvents, describeReject, clearRejectsFor, REJECTS_DDL } from '../../lib/sync-quarantine';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the hub, the device, the trigger builder and the resolver share one eligibility rule', () => {
  // The defect: three hand-maintained copies of the excluded set with different memberships, so a
  // table journalled on one side was refused on the other with HTTP 409 and no explanation.
  for (const f of ['app/api/sync/exchange/route.ts', 'app/api/sync/run/route.ts', 'app/api/sync/resolve/route.ts', 'lib/db.ts']) {
    const src = read(f);
    assert.ok(/SYNC_EXCLUDED_TABLES/.test(src), `${f} must use the shared membership`);
    assert.ok(!/new Set\(\['sync_meta'/.test(src), `${f} still declares its own excluded set`);
  }
  // Every former member is present in the one set, including the names only some copies had.
  for (const t of ['sync_meta', 'sync_changes', 'sync_applied_events', 'sync_id_mappings', 'sync_device_acks',
    'sync_resolution_log', 'sync_conflict_history', 'sync_rejects', 'users', 'login_attempts',
    'idempotency_keys', 'sqlite_sequence', 'schema_migrations']) {
    assert.ok(SYNC_EXCLUDED_TABLES.has(t), `${t} must be local-only`);
    assert.equal(syncEligibility(t).ok, false);
  }
  assert.ok(isLocalOnlyTable('license_state') && isLocalOnlyTable('admin_users'));
  assert.equal(syncEligibility('purchases').ok, true);
  assert.equal(syncEligibility('payments').ok, true);
});

test('an ineligible table is classified and explained, never reported as a bare 409 string', () => {
  const local = syncEligibility('sync_resolution_log');
  assert.equal(local.ok, false);
  if (local.ok) return;
  assert.equal(local.code, 'LOCAL_ONLY');
  assert.match(local.message, /sync_resolution_log/);
  assert.match(local.message, /never synchronised|no accounting data/);

  const bad = syncEligibility('no spaces allowed');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'INVALID_NAME');
});

function fresh() {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE parties (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  d.exec('CREATE TABLE nokey (a TEXT)');
  d.exec('CREATE TABLE sync_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, table_name TEXT, pk_json TEXT, operation TEXT, base_json TEXT, row_json TEXT, origin_device TEXT, pushed INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  d.exec('CREATE TABLE sync_applied_events (event_id TEXT PRIMARY KEY)');
  d.exec(REJECTS_DDL);
  return d;
}

test('syncTableInfo separates "not synchronised here" from "no primary key" and names the table', () => {
  const d = fresh();
  const ok = syncTableInfo(d, 'parties');
  assert.equal(ok.ok, true);
  const missing = syncTableInfo(d, 'ledger');
  assert.equal(missing.ok, false);
  if (!missing.ok) { assert.equal(missing.code, 'NOT_SYNCHRONISED'); assert.match(missing.message, /ledger/); }
  const nokey = syncTableInfo(d, 'nokey');
  assert.equal(nokey.ok, false);
  if (!nokey.ok) assert.equal(nokey.code, 'NO_PRIMARY_KEY');
});

test('a record absent on both sides resolves deterministically per operation', () => {
  const d = fresh();
  const key = JSON.stringify({ id: 7 });
  // DELETE of a record that is already gone: agreement, not a conflict.
  const del = decideAbsent(d, { table_name: 'parties', pk_json: key, operation: 'DELETE' }, { id: 7, name: 'X' });
  assert.equal(del.kind, 'noop');
  assert.equal(del.code, 'ALREADY_ABSENT');
  assert.match(del.reason, /already absent/);

  // UPDATE of a record this side never received: restored, not dropped.
  assert.equal(tombstoneFor(d, 'parties', key), null);
  const revive = decideAbsent(d, { table_name: 'parties', pk_json: key, operation: 'UPDATE' }, { id: 7, name: 'X' });
  assert.equal(revive.kind, 'revive');
  assert.equal(revive.code, 'NEVER_RECEIVED');

  // UPDATE against a record deliberately deleted here: the deletion stands, the edit is kept.
  d.prepare("INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,origin_device) VALUES('t1','parties',?,'DELETE',?,'this-device')").run(key, JSON.stringify({ id: 7, name: 'X' }));
  assert.ok(tombstoneFor(d, 'parties', key));
  const obsolete = decideAbsent(d, { table_name: 'parties', pk_json: key, operation: 'UPDATE' }, { id: 7, name: 'X' });
  assert.equal(obsolete.kind, 'obsolete');
  assert.equal(obsolete.code, 'DELETED_HERE');
  assert.match(obsolete.reason, /deliberately deleted|quarantine/);

  // A plain INSERT is unaffected.
  assert.equal(decideAbsent(d, { table_name: 'parties', pk_json: key, operation: 'INSERT' }, null).kind, 'revive');
});

test('a quarantined item keeps its event, counts attempts, is retryable and is closed on resolution', () => {
  const d = fresh();
  const event = { event_id: 'e1', table_name: 'parties', pk_json: JSON.stringify({ id: 3 }), operation: 'UPDATE', base_json: null, row_json: JSON.stringify({ id: 3, name: 'Vendor' }), origin_device: 'peer' };
  const first = recordReject(d, { phase: 'pull', event, code: 'FOREIGN_KEY', reason: 'parent missing', correlationId: 'sync-test' });
  assert.equal(first.table, 'parties');
  assert.deepEqual(first.primary_key, { id: 3 });

  recordReject(d, { phase: 'pull', event, code: 'FOREIGN_KEY', reason: 'parent missing', correlationId: 'sync-test' });
  const open = openRejects(d);
  assert.equal(open.length, 1, 'one row per event, not one per attempt');
  assert.equal(Number(open[0].attempts), 2);

  // The stored event is replayable, so a moved cursor cannot make the change unrecoverable.
  const replay = rejectedEvents(d, ['e1']);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].event.row_json, event.row_json);

  // The detail a user needs: table, key, operation, both states, reason and safe choices.
  d.prepare("INSERT INTO parties(id,name) VALUES(3,'Local Vendor')").run();
  const described = describeReject(d, open[0]);
  assert.equal(described.table, 'parties');
  assert.deepEqual(described.primary_key, { id: 3 });
  assert.equal(described.local_state.name, 'Local Vendor');
  assert.equal(described.incoming_state.name, 'Vendor');
  assert.ok(described.resolutions.length >= 2);
  assert.equal(described.correlation_id, 'sync-test');

  assert.equal(clearReject(d, 'e1'), 1);
  assert.equal(openRejects(d).length, 0);
  assert.equal(clearReject(d, 'e1'), 0, 'closing twice is idempotent');
  // The record of the rejection survives; only its open state changes.
  assert.equal(Number((d.prepare('SELECT COUNT(*) c FROM sync_rejects').get() as any).c), 1);

  // Resolving a record closes whatever it was blocking.
  recordReject(d, { phase: 'push', event, code: 'CONFLICT', reason: 'both sides changed it' });
  assert.equal(clearRejectsFor(d, 'parties', { id: 3 }), 1);
  assert.equal(clearRejectsFor(d, 'parties', { id: 999 }), 0);
});

test('reject diagnostics carry the identifiers but no row values', () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: any[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const d = fresh();
    recordReject(d, { phase: 'pull', event: { event_id: 'e2', table_name: 'payments', pk_json: '{"id":5}', operation: 'UPDATE', row_json: JSON.stringify({ id: 5, amount: 123456, narration: 'Ramesh Patel UTR 99' }), origin_device: 'peer' }, code: 'CONFLICT', reason: 'x', correlationId: 'sync-abc' });
  } finally { console.error = original; }
  const line = logged.find((l) => l.includes('SOLIVY sync reject')) || '';
  assert.match(line, /payments/);
  assert.match(line, /sync-abc/);
  assert.ok(!line.includes('123456'), 'amounts are not logged');
  assert.ok(!line.includes('Ramesh Patel'), 'personal data is not logged');
  assert.ok(!line.includes('UTR 99'), 'references are not logged');
});
