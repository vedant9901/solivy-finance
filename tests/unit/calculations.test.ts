/**
 * Golden tests documenting the CURRENT (v2.6.30) financial formulas. They are not changed in
 * v2.7.0; any future change must update these deliberately.
 *
 * purchaseCalc (lib/utils.ts):
 *   gross      = round(net_weight × rate)
 *   quality    = round(rate × quality_deduct_rate_per_kg)            if rate-per-kg rule (>0)
 *              = round(net_weight / 1000 × quality_deduct_per_mt)    otherwise
 *   discBase   = max(0, gross − quality) when discount_after_quality=1 (default), else gross
 *   discount   = round(discBase × discount_pct / 100)
 *   moistureDed= moisture (rupees) only under the per-MT rule; ignored under the per-kg rule
 *   total_ded  = round(freight + unload + moistureDed + discount + driver_rokdi + other_charges + quality)
 *   net_payable= round(gross − total_ded)
 * Financing receivable = net_payable + discount + other_charges (profit = discount + other charges).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { purchaseCalc } from '../../lib/utils';
import { decideTds } from '../../lib/tds';

test('purchaseCalc — basic deductions (discount after quality, default)', () => {
  const c = purchaseCalc({ net_weight: 10_000, rate: 50, freight: 2_000, unload_charge: 500, discount_pct: 1 });
  assert.deepEqual(c, { gross_amount: 500_000, discount_amount: 5_000, quality_deduct_amount: 0, discount_base_amount: 500_000, total_deduction: 7_500, net_payable: 492_500 });
});

test('purchaseCalc — per-MT quality deduction reduces the discount base; moisture counted once', () => {
  const c = purchaseCalc({ net_weight: 9_000, rate: 55, quality_deduct_per_mt: 200, moisture: 750, discount_pct: 2 });
  // gross 495000; quality 9 MT × 200 = 1800; base 493200; discount 9864; total 750+9864+1800
  assert.equal(c.gross_amount, 495_000); assert.equal(c.quality_deduct_amount, 1_800);
  assert.equal(c.discount_amount, 9_864); assert.equal(c.total_deduction, 12_414); assert.equal(c.net_payable, 482_586);
});

test('purchaseCalc — discount before quality when company setting is 0', () => {
  const c = purchaseCalc({ net_weight: 9_000, rate: 55, quality_deduct_per_mt: 200, discount_pct: 2, discount_after_quality: 0 });
  assert.equal(c.discount_amount, 9_900); assert.equal(c.net_payable, 495_000 - 9_900 - 1_800);
});

test('purchaseCalc — per-kg quality rule ignores the moisture rupee field (no double counting)', () => {
  const c = purchaseCalc({ net_weight: 9_000, rate: 55, quality_deduct_rate_per_kg: 120, moisture: 999 });
  assert.equal(c.quality_deduct_amount, 6_600); // round(55 × 120)
  assert.equal(c.total_deduction, 6_600);
  assert.equal(c.net_payable, 488_400);
});

test('purchaseCalc — rupee rounding of fractional weight × rate', () => {
  const c = purchaseCalc({ net_weight: 1_234.5, rate: 47.33 });
  assert.equal(c.gross_amount, Math.round(1_234.5 * 47.33));
  assert.equal(c.net_payable, c.gross_amount);
});

function tdsDb(turnover: number) {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE company_settings(id INTEGER PRIMARY KEY, deductor_type TEXT, preceding_turnover REAL);
    CREATE TABLE payments(id INTEGER PRIMARY KEY, party_id INT, payment_date TEXT, amount REAL, tds_base REAL DEFAULT 0, status TEXT);
    CREATE TABLE purchases(id INTEGER PRIMARY KEY, party_id INT, purchase_date TEXT, net_payable REAL, status TEXT);`);
  d.prepare('INSERT INTO company_settings VALUES(1,?,?)').run('COMPANY', turnover);
  return d;
}
const vendor = { id: 1, party_type: 'GOODS_VENDOR', resident_status: 'RESIDENT', pan: 'ABCDE1234F', pan_status: 'VALID', tds_exempt: 0 };

test('TDS goods purchase: not applicable when buyer turnover ≤ ₹10 crore', () => {
  const r = decideTds(tdsDb(90_000_000), vendor, '2026-06-01', 1_000_000);
  assert.equal(r.applicable, false);
});

test('TDS goods purchase: 0.1% only on the excess above ₹50 lakh aggregate purchases', () => {
  const d = tdsDb(200_000_000);
  d.prepare("INSERT INTO purchases(party_id,purchase_date,net_payable,status) VALUES(1,'2026-05-01',5200000,'POSTED')").run();
  const r = decideTds(d, vendor, '2026-06-01', 1_000_000);
  assert.equal(r.applicable, true); assert.equal(r.rate, 0.1); assert.equal(r.base, 200_000); assert.equal(r.amount, 200);
  assert.equal(r.act, 'Income-tax Act, 2025');
});

test('TDS: invalid PAN uses the higher-rate check and flags review; exempt party never auto-deducts', () => {
  const d = tdsDb(200_000_000);
  const r = decideTds(d, { ...vendor, id: 2, party_type: 'CONTRACTOR', entity_type: 'COMPANY', pan: '', pan_status: 'INVALID' }, '2026-06-01', 50_000);
  assert.equal(r.rate, 20); assert.equal(r.review, true);
  assert.equal(decideTds(d, { ...vendor, tds_exempt: 1 }, '2026-06-01', 9_000_000).applicable, false);
});

test('TDS: payments before 1 April 2026 are labelled under the Income-tax Act, 1961', () => {
  const d = tdsDb(200_000_000);
  const r = decideTds(d, { ...vendor, party_type: 'COMMISSION' }, '2026-03-15', 50_000);
  assert.equal(r.act, 'Income-tax Act, 1961'); assert.equal(r.section, 'Section 194H');
});
