import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { call, adminSession, expectOk } from '../helpers/app';
import { seedFinance } from '../helpers/seed-finance';
import { db, closeAllDatabases, databasePath } from '../../lib/db';
import { buildJournal } from '../../lib/accounting/journal';
import { trialBalance } from '../../lib/accounting/statements';
import { toPaise } from '../../lib/money';

test('stock status, inventory valuation and open purchase orders from real godown/lot/Sauda postings', async () => {
  const s = await adminSession();
  const post = async (p: string, body: any) => expectOk(await call(p, { cookie: s.cookie, body }), p);
  await post('/api/parties', { name: 'Seller', party_type: 'GOODS_VENDOR' });
  await post('/api/parties', { name: 'Buyer', party_type: 'CUSTOMER' });
  const g = await post('/api/godowns', { name: 'Unjha Yard', code: 'UNJ', capacity_qty: 500000 });
  let d = expectOk(await call('/api/data', { cookie: s.cookie }));
  const seller = d.parties.find((p: any) => p.name === 'Seller').id, buyer = d.parties.find((p: any) => p.name === 'Buyer').id;
  const godownId = g.id || (db('LIVE', s.companyId).prepare('SELECT id FROM godowns LIMIT 1').get() as any).id;
  const pur = await post('/api/purchases', { party_id: seller, purchase_date: '2026-07-01', net_weight: 10_000, gross_weight: 10_100, rate: 50, freight: 5_000, truck_number: 'GJ09K1', goods_description: 'Cumin', godown_id: godownId });
  const lot = db('LIVE', s.companyId).prepare('SELECT id FROM inventory_lots WHERE purchase_id=?').get(pur.id) as any;
  // Sauda 1: 4 MT allocated from the godown lot (fully fulfilled). Sauda 2: 25 MT booked, nothing received.
  await post('/api/saudas', { sauda_date: '2026-07-02', commodity: 'Cumin', quantity: 4, unit: 'MT', purchase_rate: 50_000, sale_rate: 53_000, purchase_entity_type: 'PARTY', purchase_entity_id: seller, selling_entity_type: 'PARTY', selling_entity_id: buyer, allocation_source: 'GODOWN', allocation_source_id: lot.id, allocation_godown_id: godownId });
  await post('/api/saudas', { sauda_date: '2026-07-03', commodity: 'Cumin', quantity: 25, unit: 'MT', purchase_rate: 52_000, sale_rate: 54_000, purchase_entity_type: 'PARTY', purchase_entity_id: seller, selling_entity_type: 'PARTY', selling_entity_id: buyer });
  const get = async (id: string) => expectOk(await call('/api/reports', { cookie: s.cookie, query: { id, as_of: '2026-12-31' } }));
  const stock = await get('stock-status');
  assert.equal(stock.data.rows[0].balance, 6_000, '10,000 kg in − 4,000 kg allocated');
  const val = await get('inventory-valuation');
  assert.equal(val.data.total_at_rate, toPaise(6_000 * 50));
  assert.equal(val.data.total_at_net_cost, toPaise(6_000 * (495_000 / 10_000)), 'net cost after ₹5,000 freight deduction');
  const po = await get('open-purchase-orders');
  assert.equal(po.data.rows.length, 1, 'fully allocated Sauda is not open');
  assert.equal(po.data.rows[0].open_quantity, 25);
  assert.equal(po.data.total_value, toPaise(25 * 52_000));
  d = expectOk(await call('/api/data', { cookie: s.cookie }));
  void d;
});

test('offline backup → restore yields an identical database and identical books', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const r = await call('/api/backup', { cookie: s.cookie, query: { company_id: s.companyId } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.buffer.subarray(0, 15).toString(), 'SQLite format 3');
  const before = trialBalance(buildJournal(db('LIVE', s.companyId)));
  // Restore procedure (docs/OPERATIONS.md): stop app → keep the current file aside → copy the backup in → start.
  closeAllDatabases();
  const file = databasePath('LIVE', s.companyId);
  fs.renameSync(file, `${file}.pre-restore`);
  for (const sfx of ['-wal', '-shm']) { try { fs.unlinkSync(file + sfx); } catch {} }
  fs.writeFileSync(file, r.buffer);
  const check = new Database(file, { readonly: true }); assert.equal(check.pragma('integrity_check', { simple: true }), 'ok'); check.close();
  const after = trialBalance(buildJournal(db('LIVE', s.companyId)));
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.rows, before.rows);
  const data = expectOk(await call('/api/data', { cookie: s.cookie }));
  assert.equal(data.purchases.length, 3);
  void path; void crypto;
});
