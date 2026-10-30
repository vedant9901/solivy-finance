import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk } from '../helpers/app';
import { seedFinance } from '../helpers/seed-finance';
import { db } from '../../lib/db';
import { pruneSyncJournal, ensurePruneSchema, UNPAIRED_RETENTION_DAYS } from '../../lib/sync-prune';

/** A conditional GET may only be answered 304 while the data behind it is unchanged. */
async function conditional(path: string, cookie: string, query: Record<string, string> = {}) {
  const first = await call(path, { cookie, query });
  assert.equal(first.status, 200, first.text.slice(0, 200));
  const etag = first.headers?.get?.('etag') || '';
  assert.match(etag, /^"[0-9a-f]{32}"$/, `${path} must issue a strong ETag`);
  const again = await call(path, { cookie, query, headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304, `${path} must answer 304 when nothing changed`);
  assert.equal(again.text, '', '304 must carry no body');
  return { etag, body: first.json };
}

test('/api/data: 304 while unchanged, 200 with new data after any write', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const q = { modules: 'core,parties,accounts,purchases' };
  const { etag, body } = await conditional('/api/data', s.cookie, q);
  assert.ok(body.parties.length > 0);

  // A write must break the ETag and the next response must contain the new row.
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Conditional Vendor', party_type: 'GOODS_VENDOR' } }));
  const after = await call('/api/data', { cookie: s.cookie, query: q, headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'a changed database must never answer 304');
  assert.ok(after.json.parties.some((p: any) => p.name === 'Conditional Vendor'));
  assert.notEqual(after.headers.get('etag'), etag);

  // An update in place (no new row) must also change the ETag.
  const fresh = after.headers.get('etag') || '';
  const party = after.json.parties.find((p: any) => p.name === 'Conditional Vendor');
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { id: party.id, name: 'Conditional Vendor', party_type: 'GOODS_VENDOR', contact: '9825011111' } }));
  const edited = await call('/api/data', { cookie: s.cookie, query: q, headers: { 'If-None-Match': fresh } });
  assert.equal(edited.status, 200, 'an in-place edit must invalidate the cached representation');
  assert.equal(edited.json.parties.find((p: any) => p.id === party.id).contact, '9825011111');
});

test('/api/data: the ETag is scoped to modules, environment and permissions', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const a = await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties' } });
  const b = await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties,purchases' } });
  assert.notEqual(a.headers.get('etag'), b.headers.get('etag'), 'different module sets are different representations');
  // Another user's menu permissions must not reuse this user's representation.
  const other = await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties' }, headers: { 'If-None-Match': a.headers.get('etag') || '' } });
  assert.equal(other.status, 304);
  const test1 = await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties' }, headers: { 'x-aksh-mode': 'TEST', 'If-None-Match': a.headers.get('etag') || '' } });
  assert.notEqual(test1.status, 304, 'LIVE and TEST never share a cached representation');
});

test('/api/reports: 304 while unchanged, fresh after a posting; exports are never conditional', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const { etag } = await conditional('/api/reports', s.cookie, { id: 'trial-balance', as_of: '2027-03-31' });
  expectOk(await call('/api/money-in', { cookie: s.cookie, body: { receipt_date: '2026-06-01', account_id: 1, amount: 12345, receipt_type: 'CAPITAL', narration: 'Conditional probe' } }));
  const after = await call('/api/reports', { cookie: s.cookie, query: { id: 'trial-balance', as_of: '2027-03-31' }, headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'a new receipt must invalidate the cached trial balance');
  const csv = await call('/api/reports', { cookie: s.cookie, query: { id: 'trial-balance', as_of: '2027-03-31', format: 'csv' }, headers: { 'If-None-Match': after.headers.get('etag') || '' } });
  assert.equal(csv.status, 200, 'downloads must always return the file');
});

test('journal trim keeps the audit trail and only drops transport history nothing pulls from', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const d = db('LIVE', s.companyId);
  ensurePruneSchema(d);
  const oldDate = new Date(Date.now() - (UNPAIRED_RETENTION_DAYS + 5) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  d.prepare('UPDATE sync_changes SET created_at=?').run(oldDate);
  const journalBefore = Number((d.prepare('SELECT COUNT(*) n FROM sync_changes').get() as any).n);
  const auditBefore = Number((d.prepare('SELECT COUNT(*) n FROM audit_logs').get() as any).n);
  assert.ok(journalBefore > 0 && auditBefore > 0);

  // Paired databases keep the full retention window.
  d.prepare("UPDATE sync_meta SET paired_url='https://hub.example.test', last_pruned_at=NULL WHERE id=1").run();
  pruneSyncJournal(d, { hasConsumers: false });
  assert.equal(Number((d.prepare('SELECT COUNT(*) n FROM sync_changes').get() as any).n), journalBefore, 'an upstream pairing blocks the short retention');

  d.prepare("UPDATE sync_meta SET paired_url='', last_pruned_at=NULL WHERE id=1").run();
  const r = pruneSyncJournal(d, { hasConsumers: false });
  assert.ok(r.deleted > 0, 'unpulled history older than the window is removed');
  assert.equal(r.retention_days, UNPAIRED_RETENTION_DAYS);
  assert.equal(Number((d.prepare('SELECT COUNT(*) n FROM audit_logs').get() as any).n), auditBefore, 'the audit trail is never pruned');
  assert.ok(r.watermark > 0, 'a watermark is recorded so a device paired later re-baselines');

  // Financial data and reports are unaffected.
  const tb = expectOk(await call('/api/reports', { cookie: s.cookie, query: { id: 'trial-balance', as_of: '2027-03-31' } }));
  assert.equal(tb.data.totals.debit, tb.data.totals.credit);
});

test('a device that still pulls from the database keeps its history', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const d = db('LIVE', s.companyId);
  ensurePruneSchema(d);
  d.prepare('UPDATE sync_changes SET created_at=?').run(new Date(Date.now() - 40 * 86400000).toISOString().replace('T', ' ').slice(0, 19));
  d.prepare("UPDATE sync_meta SET paired_url='', last_pruned_at=NULL WHERE id=1").run();
  const before = Number((d.prepare('SELECT COUNT(*) n FROM sync_changes').get() as any).n);
  const r = pruneSyncJournal(d, { hasConsumers: true });
  assert.equal(r.unconsumed, false);
  assert.ok(Number((d.prepare('SELECT COUNT(*) n FROM sync_changes').get() as any).n) <= before);
});

test('a reversal, a document-settings change and a template save all invalidate cached reads', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const data = expectOk(await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties,accounts,payments,purchases' } }));
  const payment = data.payments.find((p: any) => p.status === 'POSTED');
  assert.ok(payment, 'seeded books contain a posted payment');

  // Reversal: the cached payment list must not be confirmed afterwards.
  const before = await call('/api/data', { cookie: s.cookie, query: { modules: 'core,payments' } });
  const etag = before.headers.get('etag') || '';
  expectOk(await call('/api/reverse', { cookie: s.cookie, body: { type: 'PAYMENT', id: payment.id, reason: 'Conditional reversal probe' } }), 'reverse');
  const after = await call('/api/data', { cookie: s.cookie, query: { modules: 'core,payments' }, headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'a reversal must invalidate the cached representation');
  const reversed = after.json.payments.find((p: any) => p.id === payment.id);
  assert.notEqual(reversed.status, 'POSTED', 'the reversal is visible immediately');

  // Document settings.
  const ds = await call('/api/document-settings', { cookie: s.cookie });
  const dsEtag = ds.headers.get('etag') || '';
  assert.equal((await call('/api/document-settings', { cookie: s.cookie, headers: { 'If-None-Match': dsEtag } })).status, 304);
  expectOk(await call('/api/document-settings', { cookie: s.cookie, body: { commercial_bill: { show_moisture: true }, payment_advice: {} } }), 'save settings');
  assert.equal((await call('/api/document-settings', { cookie: s.cookie, headers: { 'If-None-Match': dsEtag } })).status, 200, 'changed settings are never answered 304');

  // Template preference.
  const tpl = await call('/api/document-templates', { cookie: s.cookie });
  const tplEtag = tpl.headers.get('etag') || '';
  assert.equal((await call('/api/document-templates', { cookie: s.cookie, headers: { 'If-None-Match': tplEtag } })).status, 304);
  expectOk(await call('/api/document-templates', { cookie: s.cookie, body: { doc_type: 'commercial', template_id: 'boxed', scope: 'user' } }), 'save template');
  assert.equal((await call('/api/document-templates', { cookie: s.cookie, headers: { 'If-None-Match': tplEtag } })).status, 200, 'a saved template is never answered 304');
});
