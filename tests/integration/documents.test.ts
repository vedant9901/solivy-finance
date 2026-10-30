import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk, seedUser, login } from '../helpers/app';
import { db } from '../../lib/db';
import { TEMPLATES } from '../../lib/documents/templates';
import { NextRequest } from 'next/server';
import { middleware } from '../../middleware';
const amt = (pdf: string, v: string) => pdf.includes(`\\(-\\) ${v}`);

let s: any; let vendor = 0; let perMt = 0; let perKg = 0; let tp = 0;
const ALL_ON = { include_unload: true, include_driver_rokdi: true, include_freight: true, include_moisture: true, include_discount: true, include_quality_deduct: true, include_other_charges: true, show_deductions: true, show_amount: true, show_truck_number: true, show_sample_no: true };

before(async () => {
  s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Doc Vendor', party_type: 'GOODS_VENDOR', address: 'APMC Yard, Unjha', gst: '24AAAAA9999A1Z5' } }));
  expectOk(await call('/api/third-parties', { cookie: s.cookie, body: { name: 'Third Party Buyer', address: 'Mumbai' } }));
  const data = expectOk(await call('/api/data', { cookie: s.cookie }));
  vendor = data.parties[0].id; tp = data.thirdParties[0].id;
  // Per-MT rule: moisture is a rupee deduction and quality is separate (v2.6.30 printed this wrongly).
  perMt = expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: vendor, purchase_date: '2026-06-10', net_weight: 9000, gross_weight: 9100, rate: 55, quality_deduct_per_mt: 200, moisture: 750, discount_pct: 2, freight: 1200, unload_charge: 300, other_charges: 150, driver_rokdi: 100, truck_number: 'GJ05TT4321', goods_description: 'Jeera', invoice_no: 'DOC-1' } })).id;
  // Per-kg rule: moisture % is the basis of the quality deduction.
  perKg = expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: vendor, purchase_date: '2026-06-11', net_weight: 9000, gross_weight: 9100, rate: 55, quality_deduct_rate_per_kg: 120, moisture: 2.5, truck_number: 'GJ05TT9999', goods_description: 'Jeera', invoice_no: 'DOC-2' } })).id;
  db('LIVE', s.companyId).prepare('UPDATE company_settings SET commercial_bill_settings=?, third_party_bill_settings=? WHERE id=1').run(JSON.stringify(ALL_ON), JSON.stringify(ALL_ON));
});

const bill = (id: number, q: Record<string, any> = {}) => call('/api/purchase-bill', { cookie: s.cookie, query: { id, ...q } });

test('every template renders both bill types with the identical total = net payable (all deductions shown)', async () => {
  const d = db('LIVE', s.companyId);
  for (const id of [perMt, perKg]) {
    const net = Math.round((d.prepare('SELECT net_payable FROM purchases WHERE id=?').get(id) as any).net_payable);
    for (const t of TEMPLATES) for (const type of ['purchase', 'third-party']) {
      const r = await bill(id, { template: t.id, bill_type: type, ...(type === 'third-party' ? { third_party_id: tp } : {}) });
      assert.equal(r.status, 200, `${t.id}/${type}: ${r.text.slice(0, 200)}`);
      assert.equal(r.text.slice(0, 5), '%PDF-');
      assert.equal(r.headers.get('x-bill-template'), t.id);
      assert.equal(Number(r.headers.get('x-bill-total')), net, `${t.id}/${type} purchase ${id}`);
    }
  }
});

test('moisture presentation (v2.7.3): the percentage is a percentage, the deduction is money, never swapped', async () => {
  // Legacy per-MT record whose stored moisture (750) is a rupee deduction, not a percentage.
  const a = (await bill(perMt, { template: 'classic' })).text;
  assert.match(a, /\(Moisture Deduction\) Tj/, 'the money row is named as a deduction');
  assert.match(a, /\(Less :\) Tj/, 'the template supplies the "Less :" prefix once');
  assert.doesNotMatch(a, /750%/, 'a rupee amount is never printed as a percentage');
  assert.match(a, /\(Quality Deduct\) Tj/); assert.ok(amt(a, '750'), 'moisture rupees printed'); assert.ok(amt(a, '1,800'), 'quality printed');
  // Per-kg rule: moisture 2.5% is informational and the quality deduction is the moisture money.
  const b = (await bill(perKg, { template: 'classic' })).text;
  assert.ok(b.includes('Moisture Deduction \\(2.5%\\)'), 'percentage shown in the label');
  assert.doesNotMatch(b, /\(Quality Deduct\) Tj/, 'one moisture row only — never deducted twice');
  assert.ok(amt(b, '6,600'), 'the amount is the one the existing calculation produced');
});

test('Truck No. prints below Sample No. only when enabled', async () => {
  for (const t of ['classic', 'modern']) {
    const on = (await bill(perMt, { template: t })).text;
    assert.match(on, /GJ05TT4321/, t);
    assert.ok(on.indexOf('(Truck No.)') > on.indexOf('Sample No.'), `${t}: truck row after sample row`);
  }
  db('LIVE', s.companyId).prepare('UPDATE company_settings SET commercial_bill_settings=? WHERE id=1').run(JSON.stringify({ ...ALL_ON, show_truck_number: false }));
  assert.doesNotMatch((await bill(perMt, { template: 'classic' })).text, /GJ05TT4321/);
  db('LIVE', s.companyId).prepare('UPDATE company_settings SET commercial_bill_settings=? WHERE id=1').run(JSON.stringify(ALL_ON));
});

test('disabling a deduction lowers the printed total consistently across templates (existing commercial-bill rule)', async () => {
  db('LIVE', s.companyId).prepare('UPDATE company_settings SET commercial_bill_settings=? WHERE id=1').run(JSON.stringify({ ...ALL_ON, include_freight: false }));
  const totals = new Set<number>();
  for (const t of TEMPLATES) totals.add(Number((await bill(perMt, { template: t.id })).headers.get('x-bill-total')));
  assert.equal(totals.size, 1);
  const net = Math.round((db('LIVE', s.companyId).prepare('SELECT net_payable FROM purchases WHERE id=?').get(perMt) as any).net_payable);
  assert.equal([...totals][0], net + 1200);
  db('LIVE', s.companyId).prepare('UPDATE company_settings SET commercial_bill_settings=? WHERE id=1').run(JSON.stringify(ALL_ON));
});

test('reversed purchase and reversed payment cannot produce documents', async () => {
  const extra = expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: vendor, purchase_date: '2026-06-12', net_weight: 100, gross_weight: 100, rate: 10, truck_number: 'X1' } })).id;
  expectOk(await call('/api/reverse', { cookie: s.cookie, body: { type: 'PURCHASE', id: extra, reason: 'test' } }));
  for (const t of ['classic', 'minimal']) { const r = await bill(extra, { template: t }); assert.equal(r.status, 500); assert.match(r.text, /reversed/i); }
  expectOk(await call('/api/accounts', { cookie: s.cookie, body: { account_name: 'Bank', bank_name: 'B', account_type: 'BANK', opening_balance: 100000, opening_date: '2026-04-01' } }));
  const acct = expectOk(await call('/api/data', { cookie: s.cookie })).accounts[0].id;
  const pay = expectOk(await call('/api/payments', { cookie: s.cookie, body: { party_id: vendor, payment_date: '2026-06-13', amount: 500, mode: 'BANK', company_account_id: acct } }));
  assert.equal((await call('/api/payment-advice', { cookie: s.cookie, query: { id: pay.id } })).status, 200);
  expectOk(await call('/api/reverse', { cookie: s.cookie, body: { type: 'PAYMENT', id: pay.id, reason: 'test' } }));
  const adv = await call('/api/payment-advice', { cookie: s.cookie, query: { id: pay.id } });
  assert.notEqual(adv.status, 200); assert.match(adv.text, /reversed/i);
});

test('template preferences: user overrides company default; permissions and validation enforced', async () => {
  expectOk(await call('/api/document-templates', { cookie: s.cookie, body: { doc_type: 'commercial', template_id: 'boxed', scope: 'company', theme: { accent: '#1d4ed8', font: 'times', density: 'compact', evil: '<script>' } } }));
  assert.equal((await bill(perMt)).headers.get('x-bill-template'), 'boxed');
  expectOk(await call('/api/document-templates', { cookie: s.cookie, body: { doc_type: 'commercial', template_id: 'minimal', scope: 'user' } }));
  assert.equal((await bill(perMt)).headers.get('x-bill-template'), 'minimal');
  const prefs = expectOk(await call('/api/document-templates', { cookie: s.cookie }));
  assert.equal(prefs.preferences.commercial.template_id, 'minimal');
  assert.equal(prefs.templates.length, 5);
  assert.equal((await call('/api/document-templates', { cookie: s.cookie, body: { doc_type: 'commercial', template_id: 'nope' } })).status, 400);
  const theme = JSON.parse((db('LIVE', s.companyId).prepare("SELECT theme FROM document_preferences WHERE scope='company'").get() as any).theme);
  assert.deepEqual(theme, { accent: '#1d4ed8', font: 'times', density: 'compact' });
  const u = `clerk_${Date.now()}`;
  await seedUser({ username: u, role: 'DATA_ENTRY', companies: [{ id: s.companyId }], menu: ['dashboard', 'purchase'] });
  const c = await login(u, s.companyId);
  assert.equal((await call('/api/document-templates', { cookie: c, body: { doc_type: 'commercial', template_id: 'modern', scope: 'company' } })).status, 403);
  expectOk(await call('/api/document-templates', { cookie: c, body: { doc_type: 'commercial', template_id: 'modern', scope: 'user' } }));
});

test('preview responses may be framed by the same origin only; everything else stays DENY', async () => {
  const p = await bill(perMt, { preview: 1 });
  assert.match(p.headers.get('content-disposition') || '', /^inline/);
  const mk = (q: string) => middleware(new NextRequest(`http://localhost:3000/api/purchase-bill?id=1${q}`, { headers: { cookie: `aksh_session=${s.cookie}` } })) as any;
  assert.equal((await mk('&preview=1')).headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await mk('')).headers.get('x-frame-options'), 'DENY');
  assert.match((await mk('&preview=1')).headers.get('content-security-policy'), /frame-ancestors 'self'/);
});

test('moisture display (v2.7.3) across records old and new, without changing any stored figure', async () => {
  const { moistureDisplay } = await import('../../lib/documents/moisture');
  const d = db('LIVE', s.companyId);

  // The stored rows and their totals must be exactly what the existing calculation produced.
  const stored = (id: number) => d.prepare('SELECT moisture, quality_deduct_rate_per_kg, quality_deduct_amount, total_deduction, net_payable, gross_amount FROM purchases WHERE id=?').get(id) as any;
  const beforePerMt = stored(perMt); const beforePerKg = stored(perKg);

  // Legacy per-MT record: the stored value is the rupee deduction; no percentage is claimed for 750.
  const mt = moistureDisplay(beforePerMt);
  assert.equal(mt.amount, 750, 'the amount is the deduction the calculation applied');
  assert.equal(mt.percent, 0, 'an implausible percentage is never shown as one');
  assert.equal(mt.percentText, '');
  assert.equal(mt.label, 'Moisture Deduction');

  // Per-kg record: 2.5% is the percentage, and the quality deduction is the moisture money.
  const kg = moistureDisplay(beforePerKg);
  assert.equal(kg.percent, 2.5);
  assert.equal(kg.percentText, '2.5%');
  assert.equal(kg.amount, Math.round(beforePerKg.quality_deduct_amount));
  assert.equal(kg.label, 'Moisture Deduction (2.5%)');

  // A record entered as a percentage under the legacy rule: 20 means 20% and ₹20 deducted.
  const twenty = expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: vendor, purchase_date: '2026-06-12', net_weight: 1000, gross_weight: 1010, rate: 50, moisture: 20, truck_number: 'GJ09MM2020', goods_description: 'Cumin' } }));
  const row20 = stored(twenty.id);
  const m20 = moistureDisplay(row20);
  assert.equal(m20.percent, 20); assert.equal(m20.percentText, '20%');
  assert.equal(m20.amount, 20, 'the deduction stays exactly what the calculation applied');
  assert.equal(m20.label, 'Moisture Deduction (20%)');
  assert.equal(Math.round(row20.net_payable), Math.round(row20.gross_amount - row20.total_deduction), 'stored totals untouched');
  const pdf20 = (await bill(twenty.id, { template: 'classic' })).text;
  assert.ok(pdf20.includes('Moisture Deduction \\(20%\\)'), 'the bill prints the percentage in the label');
  assert.ok(amt(pdf20, '20'), 'and ₹20 as the amount');

  // No moisture entered: nothing misleading appears on any template.
  const none = expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: vendor, purchase_date: '2026-06-13', net_weight: 1000, gross_weight: 1010, rate: 50, freight: 500, truck_number: 'GJ09NN0000', goods_description: 'Cumin' } }));
  assert.equal(moistureDisplay(stored(none.id)).show, false);
  for (const t of TEMPLATES) {
    const text = (await bill(none.id, { template: t.id })).text;
    assert.doesNotMatch(text, /Moisture/, `${t.id}: no moisture row when none was entered`);
  }

  // Every template prints the same moisture label and the same total for the same record.
  const labels = new Set<boolean>(); const totals = new Set<number>();
  for (const t of TEMPLATES) {
    const r = await bill(twenty.id, { template: t.id });
    labels.add(r.text.includes('Moisture Deduction \\(20%\\)'));
    totals.add(Number(r.headers.get('x-bill-total')));
  }
  assert.deepEqual([...labels], [true], 'all five templates show the percentage label');
  assert.equal(totals.size, 1, 'and the identical total');
  assert.equal([...totals][0], Math.round(row20.net_payable));

  // Payment advice uses the same presentation.
  const acct = expectOk(await call('/api/accounts', { cookie: s.cookie, body: { account_name: 'Doc Bank', bank_name: 'HDFC', account_type: 'BANK', opening_balance: 500000, opening_date: '2026-04-01' } }));
  const accountId = acct.id || (db('LIVE', s.companyId).prepare('SELECT id FROM company_accounts ORDER BY id LIMIT 1').get() as any).id;
  const pay = expectOk(await call('/api/payments', { cookie: s.cookie, body: { party_id: vendor, payment_date: '2026-06-12', amount: 1000, mode: 'BANK', company_account_id: accountId, allocations: [{ purchase_id: twenty.id, amount: 1000 }] } }));
  const advice = await call('/api/payment-advice', { cookie: s.cookie, query: { id: String(pay.id || pay.payment_id) } });
  if (advice.status === 200) {
    assert.ok(advice.text.includes('Moisture Deduction \\(20%\\)') || advice.text.includes('Moisture Deduction'), 'payment advice names the deduction, not a rupee percentage');
    assert.doesNotMatch(advice.text, /\(Moisture\) Tj/, 'the bare "Moisture" money label is gone');
  }

  // Nothing above changed a stored figure.
  assert.deepEqual(stored(perMt), beforePerMt);
  assert.deepEqual(stored(perKg), beforePerKg);
});
