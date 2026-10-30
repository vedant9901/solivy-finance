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

test('moisture presentation: per-MT shows rupee moisture AND quality; per-kg shows one Moisture (x%) row', async () => {
  const a = (await bill(perMt, { template: 'classic' })).text;
  assert.match(a, /\(Moisture\) Tj/); assert.match(a, /\(Quality Deduct\) Tj/); assert.ok(amt(a, '750'), 'moisture rupees printed'); assert.ok(amt(a, '1,800'), 'quality printed');
  const b = (await bill(perKg, { template: 'classic' })).text;
  assert.ok(b.includes('Moisture \\(2.5%\\)'), 'per-kg moisture % label'); assert.doesNotMatch(b, /\(Quality Deduct\) Tj/); assert.ok(amt(b, '6,600'));
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
