import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk, forwardedHeaders } from '../helpers/app';
import { seedFinance } from '../helpers/seed-finance';
import { db } from '../../lib/db';

test('/api/data (legacy mode) returns exactly what v2.6.30 returned, and never writes', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const legacy = await import('../fixtures/legacy/data-route-v2.6.30');
  const headers = await forwardedHeaders('/api/data', s.cookie);
  const oldJson = await (await legacy.GET(new Request('http://localhost:3000/api/data', { headers }))).json();
  const changesBefore = db('LIVE', s.companyId).prepare('SELECT COUNT(*) c FROM sync_changes').get() as any;
  const newJson = expectOk(await call('/api/data', { cookie: s.cookie }));
  const changesAfter = db('LIVE', s.companyId).prepare('SELECT COUNT(*) c FROM sync_changes').get() as any;
  assert.equal(changesAfter.c, changesBefore.c, 'GET /api/data must not write');
  delete newJson.meta;
  assert.deepEqual(Object.keys(newJson).sort(), Object.keys(oldJson).sort());
  for (const k of Object.keys(oldJson)) assert.deepEqual(newJson[k], oldJson[k], `field ${k}`);
  assert.ok(oldJson.purchases.length === 3 && oldJson.payments.length === 3 && oldJson.receivables.length === 2);
});

test('?modules returns only the requested modules and is much smaller', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const full = await call('/api/data', { cookie: s.cookie });
  const parties = await call('/api/data', { cookie: s.cookie, query: { modules: 'parties' } });
  const keys = Object.keys(parties.json).filter((k) => k !== 'meta').sort();
  assert.deepEqual(keys, ['outstanding', 'parties', 'thirdParties']);
  assert.ok(parties.bytes < full.bytes / 3, `${parties.bytes} vs ${full.bytes}`);
  const dash = expectOk(await call('/api/data', { cookie: s.cookie, query: { modules: 'accounts,money,payments,purchases,receivables' } }));
  assert.deepEqual(dash.accounts, full.json.accounts);
  assert.deepEqual(dash.purchases, full.json.purchases);
});

test('module permissions are applied before querying (clerk without payments gets none)', async () => {
  const { seedOrg, seedUser, login } = await import('../helpers/app');
  const admin = await adminSession();
  await seedFinance(admin.cookie);
  const { adminDb } = await import('../../lib/db');
  const u = `clerk_${Date.now()}`;
  await seedUser({ username: u, role: 'DATA_ENTRY', companies: [{ id: admin.companyId }], menu: ['dashboard', 'purchase'] });
  const c = await login(u, admin.companyId);
  const r = expectOk(await call('/api/data', { cookie: c, query: { modules: 'payments,purchases,ledger' } }));
  assert.deepEqual(r.payments, []); assert.deepEqual(r.ledger, []); assert.equal(r.purchases.length, 3);
  assert.equal(r.purchases[0].party_email, '', 'contact data hidden without parties permission');
  void seedOrg; void adminDb;
});
