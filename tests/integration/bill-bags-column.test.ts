/**
 * v2.12.2 — bags as a column on the commercial and third-party bills.
 *
 * Off by default, so every existing bill prints exactly as it did. Turning "Bags / Packages" on and
 * "Quantity" off swaps the weight column for the packages one; both can be shown together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBillModel } from '../../lib/documents/bill-model';

const row = {
  id: 7, bill_number: 7, sample_no: 'S-1', purchase_date: '2026-10-17', goods_description: 'Maize',
  hsn: '10059000', bags_qty: 375, gross_weight: 21890, net_weight: 21262, rate: 20,
  gross_amount: 425240, discount_amount: 0, quality_deduct_amount: 0, total_deduction: 0,
  net_payable: 425240, moisture: 0, freight: 0, unload_charge: 0, driver_rokdi: 0, other_charges: 0,
  quality_deduct_rate_per_kg: 0, quality_deduct_per_mt: 0, discount_pct: 0,
};
const build = (settings: Record<string, any>, kind: 'commercial' | 'third-party' = 'commercial') =>
  buildBillModel({ row, company: { name: 'SOLIVY' }, companyBank: {}, toParty: { name: 'AKSH ENTERPRISE' }, settings, kind });
const keys = (m: any) => m.columns.map((c: any) => c.key);

for (const kind of ['commercial', 'third-party'] as const) {
  test(`${kind} bill: bags is off by default, so an existing bill is unchanged`, () => {
    const m = build({}, kind);
    assert.ok(!keys(m).includes('bags'), `no bags column by default: ${keys(m).join(', ')}`);
    assert.ok(keys(m).includes('quantity'), 'and the quantity column is still there');
  });

  test(`${kind} bill: bags instead of quantity`, () => {
    const m = build({ show_bags: true, show_quantity: false }, kind);
    const k = keys(m);
    assert.ok(k.includes('bags'), `the bags column appears: ${k.join(', ')}`);
    assert.ok(!k.includes('quantity'), 'and the quantity column is gone');
    const bags = m.columns.find((c: any) => c.key === 'bags')!;
    assert.equal(bags.label, 'Bags');
    assert.equal(bags.value, '375 Bags', 'the packages recorded on the purchase');
    // Swapping a column changes nothing about the money.
    assert.equal(m.netPayable, 425240);
    assert.equal(m.total, 425240);
    assert.equal(m.totalMatchesNetPayable, true);
  });

  test(`${kind} bill: bags and quantity together, in invoice order`, () => {
    const k = keys(build({ show_bags: true, show_quantity: true }, kind));
    assert.ok(k.includes('bags') && k.includes('quantity'));
    assert.ok(k.indexOf('bags') < k.indexOf('quantity'), `bags precedes quantity: ${k.join(', ')}`);
    if (k.includes('hsn')) assert.ok(k.indexOf('hsn') < k.indexOf('bags'), 'and follows HSN');
  });
}

test('a purchase with no bags recorded shows no bags column even when the option is on', () => {
  const m = buildBillModel({ row: { ...row, bags_qty: 0 }, company: { name: 'SOLIVY' }, companyBank: {}, toParty: { name: 'X' }, settings: { show_bags: true }, kind: 'commercial' });
  assert.ok(!keys(m).includes('bags'), 'nothing is printed for a figure that was never entered');
});

test('the bags option is offered for both bills in document settings, defaulting to off', async () => {
  const app = await import('../helpers/app');
  const s = await app.adminSession('LIVE');
  const got = app.expectOk(await app.call('/api/document-settings', { cookie: s.cookie }));
  for (const kind of ['commercial_bill', 'third_party_bill']) {
    assert.ok(kind in got, `${kind} settings are returned`);
    assert.equal(got[kind].show_bags, false, `${kind}: off by default`);
  }
  // And it saves and comes back.
  app.expectOk(await app.call('/api/document-settings', { cookie: s.cookie, body: { commercial_bill: { show_bags: true }, third_party_bill: { show_bags: true } } }));
  const after = app.expectOk(await app.call('/api/document-settings', { cookie: s.cookie }));
  assert.equal(after.commercial_bill.show_bags, true);
  assert.equal(after.third_party_bill.show_bags, true);
});
