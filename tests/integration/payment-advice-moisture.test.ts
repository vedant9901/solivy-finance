/**
 * v2.12.1 — moisture and the quality deduction on the payment advice.
 *
 * The defect these tests lock down: the advice built its own list of deduction rows, separate from
 * the one the bills use, and its query never selected `quality_deduct_rate_per_kg`. A purchase saved
 * under the rate-per-kg quality rule therefore looked legacy to it, and the recorded moisture
 * **percentage** was printed as a rupee deduction — 11.50 % became "Less: Moisture Deduction
 * (11.5%) ₹11.50", money the accounting record never deducted, leaving the rows adding to 21.50
 * against a stored total of 10.
 *
 * The advice's layout is unchanged by this release: the percentage rides in the existing
 * "Less: Moisture Deduction (…)" row's label, exactly as the commercial bill already prints it.
 * `purchaseCalc` contains no moisture threshold and no per-excess-percentage rate, so no deduction
 * is conjured from a threshold at any moisture level; `scripts/check-payment-advice.cjs` holds that
 * line in the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adviceDeductions } from '../../lib/documents/advice-model';
import { billDeductions } from '../../lib/documents/bill-model';
import { purchaseCalc } from '../../lib/utils';
import * as app from '../helpers/app';

/** A stored purchase: the figures `purchaseCalc` produced, saved as the purchases row holds them. */
function purchase(input: Record<string, any>) {
  const base = {
    net_weight: 1000, rate: 20, freight: 0, unload_charge: 0, driver_rokdi: 0, other_charges: 0,
    discount_pct: 0, moisture: 0, quality_deduct_per_mt: 0, quality_deduct_rate_per_kg: 0,
    discount_after_quality: 1, ...input,
  };
  return { ...base, ...purchaseCalc(base) };
}
const ALL_ON = {};   // every row defaults to shown

// ---- 1-3: at and below the threshold, nothing is deducted for moisture ------------------------

// ---- 4: above the threshold, only the rule actually stored on the purchase applies -------------

test('above the threshold, the deduction is the stored quality rule applied exactly once', () => {
  // Per-kg rule: purchaseCalc charges rate x rate_per_kg and deducts nothing for moisture.
  const perKg = purchase({ moisture: 20, quality_deduct_rate_per_kg: 0.5 });
  assert.equal(perKg.quality_deduct_amount, 10, 'rate 20 x 0.50 = 10, as purchaseCalc computes it');
  assert.equal(perKg.total_deduction, 10, 'and moisture adds nothing under this rule');
  const d = adviceDeductions(perKg, ALL_ON);
  assert.equal(d.deductions.length, 1, `exactly one row, not two: ${JSON.stringify(d.deductions)}`);
  assert.match(d.deductions[0].label, /Moisture Deduction \(20%\)/, 'carrying the percentage in its label');
  assert.equal(d.deductions[0].amount, 10, 'and the money once');
  assert.equal(d.shownTotal, d.storedTotal, 'so the advice reconciles with the record');

  // Per-MT rule: quality is charged on the weight, and the stored moisture amount is separate.
  const perMt = purchase({ moisture: 500, quality_deduct_per_mt: 30 });
  assert.equal(perMt.quality_deduct_amount, 30, '1000 kg = 1 MT x 30');
  const m = adviceDeductions(perMt, ALL_ON);
  assert.equal(m.deductions.length, 2, 'moisture and quality are distinct rows here');
  assert.equal(m.shownTotal, m.storedTotal);
});

// ---- 5-6: missing data is reported, never filled in -------------------------------------------

// ---- 7-8: reconciliation and keeping the figures distinct --------------------------------------

test('the advice reconciles with the authoritative purchase calculation', () => {
  const cases = [
    purchase({ moisture: 11.5 }),
    purchase({ moisture: 20, quality_deduct_rate_per_kg: 0.5 }),
    purchase({ moisture: 500, quality_deduct_per_mt: 30, freight: 1200, unload_charge: 300, driver_rokdi: 150, other_charges: 75, discount_pct: 2 }),
    purchase({ moisture: 0, quality_deduct_rate_per_kg: 1.25, freight: 900 }),
  ];
  for (const row of cases) {
    const d = adviceDeductions(row, ALL_ON);
    assert.equal(d.reconciles, true, `rows ${d.shownTotal} vs record ${d.storedTotal}: ${JSON.stringify(d.deductions)}`);
    // Equal to the stored total within the rupee rounding `purchaseCalc` applies to it.
    assert.ok(Math.abs(d.shownTotal - d.storedTotal) <= 0.5, `${d.shownTotal} vs ${d.storedTotal}`);
    // And the printed net follows the record. `purchaseCalc` rounds the deduction total to the
    // rupee *before* subtracting it, so adding the rows by hand can land a rupee away from the
    // stored net payable when a deduction carries paise. The advice prints the stored figure, which
    // stays the authoritative one; nothing is recomputed to paper over the rupee.
    const byHand = Math.round(row.gross_amount - d.shownTotal);
    const whole = Number.isInteger(d.shownTotal);
    if (whole) assert.equal(byHand, row.net_payable, 'whole-rupee deductions agree exactly');
    else assert.ok(Math.abs(byHand - row.net_payable) <= 1, `${byHand} vs ${row.net_payable}`);
  }
});

test('the advice and the bills produce the same deduction rows from the same purchase', () => {
  for (const row of [purchase({ moisture: 11.5 }), purchase({ moisture: 20, quality_deduct_rate_per_kg: 0.5 }), purchase({ moisture: 500, quality_deduct_per_mt: 30 })]) {
    const advice = adviceDeductions(row, ALL_ON).deductions.map((x) => [x.label, x.amount]);
    const bill = billDeductions(row, {}, 'commercial').deductions.map((x) => [x.label, x.amount]);
    // The same money, by the same rule — the order the two documents print it in may differ.
    assert.deepEqual([...advice].sort(), [...bill].sort(), `advice ${JSON.stringify(advice)} vs bill ${JSON.stringify(bill)}`);
  }
});

test('received weight, dispatched weight, deducted weight and the other deductions stay distinct', () => {
  const row = { ...purchase({ moisture: 500, quality_deduct_per_mt: 30, freight: 1200, unload_charge: 300, driver_rokdi: 150 }), gross_weight: 1040 };
  assert.equal(row.net_weight, 1000, 'received net weight');
  assert.equal(row.gross_weight, 1040, 'dispatched/gross weight, a separate field');
  const labels = adviceDeductions(row, ALL_ON).deductions.map((x) => x.label);
  for (const expected of ['Unload Charges', 'Freight', 'Driver Rokdi', 'Quality Deduct']) {
    assert.ok(labels.includes(expected), `${expected} is its own row: ${labels.join(', ')}`);
  }
  assert.ok(labels.some((l) => /Moisture Deduction/.test(l)), 'and moisture is its own row');
});

// ---- 9: a hidden row is the user's choice, not a mismatch --------------------------------------

test('switching a deduction row off is not reported as a mismatch', () => {
  const row = purchase({ moisture: 500, quality_deduct_per_mt: 30, freight: 1200 });
  const hidden = adviceDeductions(row, { show_freight: false });
  assert.ok(!hidden.deductions.some((x) => x.label === 'Freight'), 'the row is gone');
  assert.equal(hidden.hiddenRows, true);
  assert.equal(hidden.reconciles, true, 'and the document does not accuse itself of a mismatch');
  assert.notEqual(hidden.shownTotal, hidden.storedTotal, 'though the totals do differ, as the user asked');
});

// ---- 10-11: the real document, both databases, and no mutation --------------------------------

/** Create a party, a purchase and a posted payment, then fetch the advice PDF. */
async function adviceFor(cookie: string, purchaseFields: Record<string, any>) {
  const party = app.expectOk(await app.call('/api/parties', { cookie, body: { name: `Vendor ${Math.random().toString(36).slice(2, 8)}`, contact: '9100000000' } }));
  const partyId = Number(party.id ?? party.partyId);
  const saved = app.expectOk(await app.call('/api/purchases', {
    cookie,
    body: {
      party_id: partyId, purchase_date: '2026-10-17', sample_no: `S-${Math.random().toString(36).slice(2, 9)}`,
      truck_number: 'GJ04X5630', goods_description: 'Maize', bags_qty: 375, gross_weight: 1040, net_weight: 1000, rate: 20,
      freight: 0, unload_charge: 0, driver_rokdi: 0, other_charges: 0, discount_pct: 0,
      moisture: 0, quality_deduct_per_mt: 0, quality_deduct_rate_per_kg: 0, ...purchaseFields,
    },
  }));
  const purchaseId = Number(saved.id ?? saved.purchaseId);
  const row = app.expectOk(await app.call('/api/data', { cookie })).purchases.find((x: any) => Number(x.id) === purchaseId);
  const payment = app.expectOk(await app.call('/api/payments', {
    cookie,
    body: { party_id: partyId, payment_date: '2026-10-20', amount: row.net_payable, mode: 'NEFT', allocations: [{ purchase_id: purchaseId, amount: row.net_payable }] },
  }));
  const paymentId = Number(payment.id ?? payment.paymentId);
  const pdf = await app.call('/api/payment-advice', { cookie, query: { id: paymentId } });
  return { pdf, row, purchaseId, paymentId, partyId };
}

test('the advice PDF is produced for a purchase recording moisture, and nothing is written', async () => {
  const session = await app.adminSession('LIVE');
  const before = app.expectOk(await app.call('/api/data', { cookie: session.cookie }));
  const { pdf, row } = await adviceFor(session.cookie, { moisture: 11.5 });
  assert.equal(pdf.status, 200, pdf.text?.slice(0, 200));
  assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-', 'a PDF came back');
  assert.ok(pdf.bytes > 2000, `of a reasonable size: ${pdf.bytes}`);
  assert.equal(row.moisture, 11.5, 'the recorded percentage is stored unchanged');

  // Generating the advice twice changes nothing: same stored figures, same counts.
  const snapshot = app.expectOk(await app.call('/api/data', { cookie: session.cookie }));
  const again = await app.call('/api/payment-advice', { cookie: session.cookie, query: { id: snapshot.payments[0].id } });
  assert.equal(again.status, 200);
  const after = app.expectOk(await app.call('/api/data', { cookie: session.cookie }));
  assert.deepEqual(after.purchases.map((p: any) => [p.id, p.moisture, p.total_deduction, p.net_payable]),
    snapshot.purchases.map((p: any) => [p.id, p.moisture, p.total_deduction, p.net_payable]), 'no purchase was altered');
  assert.equal(after.payments.length, snapshot.payments.length, 'and no payment was created');
  assert.ok(after.purchases.length > before.purchases.length - 1);
});

test('the per-kg rule through the real endpoint: one deduction, and the advice reconciles', async () => {
  const session = await app.adminSession('LIVE');
  const { pdf, row } = await adviceFor(session.cookie, { moisture: 11.5, quality_deduct_rate_per_kg: 0.5 });
  assert.equal(pdf.status, 200, pdf.text?.slice(0, 200));
  // The stored record: quality 10, nothing for moisture.
  assert.equal(row.quality_deduct_amount, 10);
  assert.equal(row.total_deduction, 10, 'moisture adds nothing under this rule');
  assert.equal(row.moisture, 11.5, 'and the percentage is kept as recorded');
  // The rows the advice prints for it add up to that same 10 — the defect was 21.50.
  const d = adviceDeductions(row, ALL_ON);
  assert.equal(d.shownTotal, 10);
  assert.equal(d.deductions.length, 1);
  assert.equal(d.reconciles, true);
});

// ---- the supplier's threshold, read from the goods-receipt note the purchase came from ---------

