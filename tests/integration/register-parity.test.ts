import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk } from '../helpers/app';
import { db } from '../../lib/db';
import { purchaseCalc, effectiveDiscountRule } from '../../lib/utils';

/**
 * The Purchase/Sample register shows the stored net_payable; the purchase form computes it live.
 * They disagreed by quality × discount% whenever the company discount base changed after a record
 * was saved. These tests prove the cause and that both now agree for old and new records, without
 * any stored figure changing.
 */
const setRule = (companyId: number, rule: number) => db('LIVE', companyId).prepare('UPDATE company_settings SET discount_after_quality=? WHERE id=1').run(rule);

async function makePurchase(cookie: string, extra: Record<string, any> = {}) {
  return expectOk(await call('/api/purchases', { cookie, body: { party_id: 1, purchase_date: '2026-06-01', net_weight: 39000, gross_weight: 39100, rate: 28, discount_pct: 5, quality_deduct_per_mt: 534.35, freight: 1000, unload_charge: 400, truck_number: 'GJ09RR1234', invoice_no: '311', goods_description: 'Cumin', ...extra } }), 'create purchase');
}

test('the register total and the form total agree after the company discount base changes', async () => {
  const s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'DAMODAR SHYAMSUNDAR', party_type: 'GOODS_VENDOR' } }));
  const d = db('LIVE', s.companyId);

  // Saved while the discount applies to the gross amount.
  setRule(s.companyId, 0);
  const created = await makePurchase(s.cookie);
  const stored = d.prepare('SELECT * FROM purchases WHERE id=?').get(created.id) as any;
  assert.equal(Number(stored.discount_after_quality), 0, 'the rule in force is recorded with the record');
  const stamp = { net: Math.round(stored.net_payable), deduction: Math.round(stored.total_deduction), discount: Math.round(stored.discount_amount) };

  // The setting is changed afterwards. Historic documents are never recalculated.
  setRule(s.companyId, 1);
  const after = d.prepare('SELECT * FROM purchases WHERE id=?').get(created.id) as any;
  assert.equal(Math.round(after.net_payable), stamp.net, 'the stored total is untouched');

  // The register (stored) and the form (rule the record was saved with) are the same figure.
  const row = expectOk(await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties,purchases' } })).purchases.find((p: any) => p.id === created.id);
  assert.equal(row.net_payable_matches, true, 'the stored total is reproducible from the stored inputs');
  assert.equal(row.discount_rule_used, 0);
  assert.equal(Math.round(row.net_payable_calc), stamp.net, 'the form figure equals the register figure');

  // Computing with today's setting instead is what used to produce the mismatch.
  const wrong = Math.round(purchaseCalc({ ...after, discount_after_quality: 1 }).net_payable);
  assert.notEqual(wrong, stamp.net, 'the defect is reproducible: the wrong base gives a different total');
  assert.equal(wrong - stamp.net, Math.round(Math.round(after.quality_deduct_amount) * Number(after.discount_pct) / 100), 'the difference is exactly quality × discount%');
});

test('a legacy record with no recorded rule is read with the rule that reproduces its stored total', async () => {
  const s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Legacy Vendor', party_type: 'GOODS_VENDOR' } }));
  const d = db('LIVE', s.companyId);
  setRule(s.companyId, 0);
  const created = await makePurchase(s.cookie, { invoice_no: '312' });
  // Simulate a record stored before v2.8.0: the rule column is empty.
  d.prepare('UPDATE purchases SET discount_after_quality=NULL WHERE id=?').run(created.id);
  const legacy = d.prepare('SELECT * FROM purchases WHERE id=?').get(created.id) as any;
  setRule(s.companyId, 1);

  const resolved = effectiveDiscountRule(legacy, 1);
  assert.equal(resolved.reproduces, true);
  assert.equal(resolved.rule, 0, 'the rule is derived from the stored total, not assumed');
  assert.equal(resolved.calculated, Math.round(legacy.net_payable));

  const row = expectOk(await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties,purchases' } })).purchases.find((p: any) => p.id === created.id);
  assert.equal(row.net_payable_matches, true);
  assert.equal(Math.round(row.net_payable_calc), Math.round(legacy.net_payable));
});

test('a stored total that no rule reproduces is flagged, never silently replaced', async () => {
  const s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Odd Vendor', party_type: 'GOODS_VENDOR' } }));
  const d = db('LIVE', s.companyId);
  const created = await makePurchase(s.cookie, { invoice_no: '313' });
  d.prepare('UPDATE purchases SET net_payable=net_payable+777, discount_after_quality=NULL WHERE id=?').run(created.id);
  const row = expectOk(await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties,purchases' } })).purchases.find((p: any) => p.id === created.id);
  assert.equal(row.net_payable_matches, false, 'the row is flagged for review');
  assert.equal(Math.round(row.net_payable), Math.round((d.prepare('SELECT net_payable FROM purchases WHERE id=?').get(created.id) as any).net_payable), 'the stored figure is still what is shown');
  assert.notEqual(Math.round(row.net_payable_calc), Math.round(row.net_payable));
});

test('editing a record keeps its own discount base, and a new record uses the current setting', async () => {
  const s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Edit Vendor', party_type: 'GOODS_VENDOR' } }));
  const d = db('LIVE', s.companyId);
  setRule(s.companyId, 0);
  const first = await makePurchase(s.cookie, { invoice_no: '314' });
  setRule(s.companyId, 1);
  const second = await makePurchase(s.cookie, { invoice_no: '315', purchase_date: '2026-06-02' });
  assert.equal(Number((d.prepare('SELECT discount_after_quality FROM purchases WHERE id=?').get(second.id) as any).discount_after_quality), 1, 'a new record records today’s rule');
  assert.equal(Number((d.prepare('SELECT discount_after_quality FROM purchases WHERE id=?').get(first.id) as any).discount_after_quality), 0, 'the earlier record keeps its own');
  const rows = expectOk(await call('/api/data', { cookie: s.cookie, query: { modules: 'core,parties,purchases' } })).purchases;
  for (const r of rows.filter((x: any) => [first.id, second.id].includes(x.id))) {
    assert.equal(r.net_payable_matches, true, `purchase ${r.id} reproducible`);
    assert.equal(Math.round(r.net_payable_calc), Math.round(r.net_payable), `purchase ${r.id}: register equals form`);
  }
});
