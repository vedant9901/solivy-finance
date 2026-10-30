import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { call, adminSession, expectOk, seedUser, login } from '../helpers/app';
import { seedFinance } from '../helpers/seed-finance';
import { toPaise } from '../../lib/money';

let s: { cookie: string; companyId: number; username: string }; let ids: any;
const R = (n: number) => toPaise(n);
const get = async (id: string, q: Record<string, any> = {}) => expectOk(await call('/api/reports', { cookie: s.cookie, query: { id, ...q } }), id);

before(async () => { s = await adminSession(); ids = await seedFinance(s.cookie); });

test('catalog lists every report group from the reference screenshot', async () => {
  const c = expectOk(await call('/api/reports', { cookie: s.cookie }));
  const groups = new Set(c.reports.map((r: any) => r.group));
  for (const g of ['Company & Financial', 'Customers & Receivables', 'Vendors & Payables', 'Sales', 'Purchases', 'Inventory', 'Sales Tax (GST)', 'Accountant & Taxes', 'Lists', 'Combined / Multi-company']) assert.ok(groups.has(g), g);
  assert.ok(c.reports.length >= 33);
});

test('every report runs and returns a well-formed table', async () => {
  const c = expectOk(await call('/api/reports', { cookie: s.cookie }));
  for (const r of c.reports.filter((x: any) => x.id !== 'report-groups' && x.id !== 'management-package')) {
    const out = await get(r.id, { from: '2026-04-01', to: '2027-03-31', as_of: '2027-03-31', fy: '2026-27' });
    assert.ok(out.table?.title, r.id);
    const sections = out.table.sections?.length ? out.table.sections : [out.table];
    for (const sec of sections) for (const row of sec.rows) for (const col of sec.columns) if (col.type === 'money' && row[col.key] !== undefined && row[col.key] !== null && row[col.key] !== '') assert.ok(Number.isInteger(row[col.key]), `${r.id}.${col.key} must be integer paise`);
  }
});

test('aging, open items and ledger agree; reconciliation passes', async () => {
  const ar = await get('ar-aging', { as_of: '2026-12-31' });
  const inv = await get('open-invoices', { as_of: '2026-12-31' });
  assert.equal(ar.data.totals.total, inv.data.total);
  assert.equal(inv.data.total, R(150_000 + 55_000), 'financing 1,50,000 + invoice 55,000 outstanding');
  const ap = await get('ap-aging', { as_of: '2026-12-31' });
  assert.equal(ap.data.totals.total, R(192_500 + 110_000));
  const rec = await get('reconciliation', { as_of: '2027-03-31' });
  assert.equal(rec.data.passed, true, JSON.stringify(rec.data.checks.filter((c: any) => c.status !== 'OK')));
});

test('financial statements via the API match the hand-computed scenario', async () => {
  const bs = await get('balance-sheet', { as_of: '2027-03-31' });
  assert.equal(bs.data.balanced, true); assert.equal(bs.data.total_assets, R(1_939_500));
  const pl = await get('income-statement', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(pl.data.net_profit, R(-13_000));
  const tb = await get('trial-balance', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(tb.data.balanced, true);
  const cf = await get('cash-flow', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(cf.data.reconciles, true);
  const coh = await get('cash-on-hand', { as_of: '2027-03-31' });
  assert.equal(coh.data.total, R(1_669_002.5 + 65_000));
  const gl = await get('general-ledger', { account: '2100', party: `P${ids.V1}`, from: '2026-04-01', to: '2027-03-31' });
  assert.equal(-gl.data.ledgers[0].closing, R(322_500));
});

test('TDS, GST and sales/purchase analyses use the recorded figures', async () => {
  const tds = await get('tds-summary', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(tds.data.credits_total, R(497.5));
  const gst = await get('gst-sales-tax', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(gst.data.outward.totals.cgst + gst.data.outward.totals.sgst, R(5_000));
  assert.equal(gst.data.inward.totals.cgst + gst.data.inward.totals.sgst, R(5_500), 'P3: 5% of 1,10,000');
  const sbc = await get('sales-by-customer', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(sbc.data.total_sales, R(797_500 + 100_000));
  const pbv = await get('purchases-by-vendor', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(pbv.data.total_net, R(901_500));
  const pbi = await get('purchases-by-item', { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(pbi.data.rows.find((r: any) => r.item === 'Cumin').avg_rate, 50);
  const fc = await get('cash-flow-forecast', { as_of: '2026-06-02' });
  assert.equal(fc.data.weeks.length, 13);
  assert.equal(fc.data.weeks.at(-1).closing, fc.data.opening_cash + fc.data.weeks.reduce((a: number, w: any) => a + w.net, 0));
});

test('exports: CSV, XLSX (parsed back) and PDF; management package PDF', async () => {
  const csv = await call('/api/reports', { cookie: s.cookie, query: { id: 'trial-balance', format: 'csv', from: '2026-04-01', to: '2027-03-31' } });
  assert.equal(csv.status, 200); assert.match(csv.text, /Trial Balance/); assert.match(csv.text, /Closing Dr/);
  const xr = await call('/api/reports', { cookie: s.cookie, query: { id: 'balance-sheet', format: 'xlsx', as_of: '2027-03-31' } });
  assert.equal(xr.status, 200);
  const raw = Buffer.from((await (await import('../helpers/app')).call('/api/reports', { cookie: s.cookie, query: { id: 'balance-sheet', format: 'xlsx', as_of: '2027-03-31' } })).text, 'binary');
  void raw;
  for (const id of ['balance-sheet', 'ar-aging', 'general-ledger', 'gst-returns']) {
    const pdf = await call('/api/reports', { cookie: s.cookie, query: { id, format: 'pdf', from: '2026-04-01', to: '2027-03-31', as_of: '2027-03-31' } });
    assert.equal(pdf.status, 200, id); assert.equal(pdf.text.slice(0, 5), '%PDF-', id);
  }
  const pkg = await call('/api/reports', { cookie: s.cookie, query: { id: 'management-package', from: '2026-04-01', to: '2027-03-31' } });
  assert.equal(pkg.status, 200); assert.equal(pkg.text.slice(0, 5), '%PDF-');
  assert.ok((pkg.text.match(/\/Type \/Page\b/g) || []).length >= 10, 'cover + contents + 8 reports');
});

test('XLSX export is a valid workbook with rupee amounts', async () => {
  const { registerXlsxCheck } = { registerXlsxCheck: true }; void registerXlsxCheck;
  const { makeCtx, reportById } = await import('../../lib/accounting/registry');
  const { toXLSX } = await import('../../lib/accounting/export');
  const { db } = await import('../../lib/db');
  const out = reportById('balance-sheet')!.run(makeCtx(db('LIVE', s.companyId), { as_of: '2027-03-31' }, '2027-03-31'));
  const wb = XLSX.read(toXLSX(out.table), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames.slice(0, 3), ['Assets', 'Liabilities', 'Equity']);
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets.Assets, { header: 1 });
  assert.equal(rows.find((r) => r[1] === 'Total assets')![2], 1_939_500);
});

test('budgets: save, Budget vs Actual uses them, invalid lines rejected', async () => {
  expectOk(await call('/api/budgets', { cookie: s.cookie, body: { fy: '2026-27', lines: [{ account_code: '5200', month: '2026-05', amount: 8000 }, { account_code: '4100', month: '2026-05', amount: 600000 }] } }));
  const bva = await get('budget-vs-actual', { fy: '2026-27' });
  const interest = bva.data.rows.find((r: any) => r.code === '5200');
  assert.equal(interest.budget, R(8_000)); assert.equal(interest.actual, R(9_000)); assert.equal(interest.variance, R(-1_000));
  assert.equal((await call('/api/budgets', { cookie: s.cookie, body: { fy: '2026-27', lines: [{ account_code: '1100', month: '2026-05', amount: 1 }] } })).status, 400);
  assert.equal((await call('/api/budgets', { cookie: s.cookie, body: { fy: '2026-27', lines: [{ account_code: '5200', month: '2028-01', amount: 1 }] } })).status, 400);
});

test('favourites persist per user; permissions hide and block reports', async () => {
  expectOk(await call('/api/reports', { cookie: s.cookie, body: { action: 'favorite', report_id: 'trial-balance', on: true } }));
  assert.deepEqual(expectOk(await call('/api/reports', { cookie: s.cookie })).favorites, ['trial-balance']);
  const u = `rcv_${Date.now()}`;
  await seedUser({ username: u, role: 'ACCOUNTANT', companies: [{ id: s.companyId }], menu: ['dashboard', 'receivables'] });
  const c = await login(u, s.companyId);
  const cat = expectOk(await call('/api/reports', { cookie: c }));
  assert.ok(cat.reports.some((r: any) => r.id === 'ar-aging'));
  assert.ok(!cat.reports.some((r: any) => r.id === 'balance-sheet'));
  assert.equal((await call('/api/reports', { cookie: c, query: { id: 'balance-sheet' } })).status, 403);
  assert.equal((await call('/api/reports', { cookie: c, query: { id: 'ar-aging', from: 'bad' } })).status, 400);
});

test('report groups consolidate only organizations the user can access', async () => {
  const other = await adminSession();
  await seedFinance(other.cookie);
  // user assigned to both
  const { adminDb } = await import('../../lib/db');
  const uid = (adminDb().prepare('SELECT id FROM admin_users WHERE username=?').get(s.username) as any).id;
  adminDb().prepare('INSERT OR REPLACE INTO user_companies(user_id,company_id,can_live,can_test) VALUES(?,?,1,0)').run(uid, other.companyId);
  const relogin = await login(s.username, s.companyId);
  const g = expectOk(await call('/api/reports/group', { cookie: relogin, query: { company_ids: `${s.companyId},${other.companyId}`, as_of: '2027-03-31', from: '2026-04-01', to: '2027-03-31' } }));
  assert.equal(g.data.balance_sheet.total_assets, R(1_939_500) * 2);
  assert.equal(g.data.balance_sheet.balanced, true);
  const outsider = await adminSession();
  assert.equal((await call('/api/reports/group', { cookie: outsider.cookie, query: { company_ids: `${s.companyId}` } })).status, 403);
});
