/**
 * Ledger reconciliation against a hand-computed scenario (tests/helpers/seed-finance.ts).
 * Hand figures (₹): HDFC 16,69,002.50 · Cash 65,000 · AR financing 1,50,000 · AR invoices 55,000 ·
 * TDS receivable 497.50 · AP 3,22,500 · GST output 5,000 · Loans 4,00,000 · Capital 2,00,000 ·
 * Opening equity 10,30,000 · Drawings 5,000 · Sales 7,97,500 + 1,00,000 · Purchases 9,01,500 ·
 * Interest 9,000 → loss 13,000; Assets 19,39,500 = Liabilities 7,27,500 + Equity 12,12,000.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk } from '../helpers/app';
import { seedFinance } from '../helpers/seed-finance';
import { db } from '../../lib/db';
import { buildJournal, isBank } from '../../lib/accounting/journal';
import { trialBalance, balanceSheet, incomeStatement, cashFlow, generalLedger, partyBalances, cashOnHand } from '../../lib/accounting/statements';
import { toPaise } from '../../lib/money';

const R = (n: number) => toPaise(n);

test('derived journal: every voucher balances, books balance, and figures match the hand computation', async () => {
  const s = await adminSession();
  const ids = await seedFinance(s.cookie);
  const d = db('LIVE', s.companyId);
  const j = buildJournal(d);
  for (const v of j.vouchers) assert.equal(v.lines.reduce((a, l) => a + l.debit, 0), v.lines.reduce((a, l) => a + l.credit, 0), `voucher ${v.id} balanced`);
  const hard = j.exceptions.filter((e) => e.severity !== 'low' && e.code !== 'REVIEW_CLASSIFICATION');
  assert.deepEqual(hard, [], 'no unexplained exceptions');

  const tb = trialBalance(j);
  assert.equal(tb.balanced, true);
  const bal = (code: string) => { const r = tb.rows.find((x) => x.code === code); return r ? r.closing_debit - r.closing_credit : 0; };
  assert.equal(bal(`1100.${ids.A}`), R(1_669_002.5));
  assert.equal(bal(`1100.${ids.CASH}`), R(65_000));
  assert.equal(bal('1200'), R(150_000));
  assert.equal(bal('1210'), R(55_000));
  assert.equal(bal('1300'), R(497.5));
  assert.equal(-bal('2100'), R(322_500));
  assert.equal(-bal('2300'), R(5_000));
  assert.equal(-bal('2400'), R(400_000));
  assert.equal(-bal('3100'), R(200_000));
  assert.equal(-bal('3900'), R(1_030_000));
  assert.equal(bal('3200'), R(5_000));
  assert.equal(-bal('4100'), R(797_500));
  assert.equal(-bal('4200'), R(100_000));
  assert.equal(bal('5100'), R(901_500));
  assert.equal(bal('5200'), R(9_000));
  assert.equal(bal('1900'), 0, 'suspense must be zero');

  const pl = incomeStatement(j);
  assert.equal(pl.net_profit, R(-13_000));
  assert.equal(pl.gross_profit, R(797_500 + 100_000 - 901_500));
  const bs = balanceSheet(j, '2027-03-31');
  assert.equal(bs.balanced, true);
  assert.equal(bs.total_assets, R(1_939_500));
  assert.equal(bs.total_liabilities, R(727_500));
  assert.equal(bs.total_equity, R(1_212_000));
});

test('reconciliation: bank GL equals the application balance per account; party sub-ledgers equal source registers', async () => {
  const s = await adminSession();
  const ids = await seedFinance(s.cookie);
  const j = buildJournal(db('LIVE', s.companyId));
  const data = expectOk(await call('/api/data', { cookie: s.cookie }));
  const coh = cashOnHand(j, '9999-12-31');
  for (const a of data.accounts) assert.equal(coh.rows.find((r) => r.code === `1100.${a.id}`)?.balance, toPaise(a.balance), a.account_name);
  // Trade payables per party = opening + posted purchases − posted payments (gross)
  const ap = partyBalances(j, '2100');
  assert.equal(ap.find((x) => x.party === `P${ids.V1}`)?.balance, R(322_500));
  assert.equal(ap.find((x) => x.party === `P${ids.V2}`)?.balance ?? 0, 0);
  // v2.6.30 outstanding (allocated basis) agrees here because all payments were fully allocated
  const out = data.outstanding.find((o: any) => o.id === ids.V1);
  assert.equal(toPaise(out.outstanding), R(322_500));
  // Financing receivables per bill = receivable − received
  for (const r of data.receivables) {
    const gl = generalLedger(j, '1200', {}, `P${r.party_id}`);
    assert.ok(gl.closing >= 0);
  }
  const ar = partyBalances(j, '1200');
  const expected = data.receivables.reduce((s: number, r: any) => s + toPaise(r.receivable_amount) - toPaise(r.received_amount), 0);
  assert.equal(ar.reduce((s, x) => s + x.balance, 0), expected);
});

test('cash flow (direct) reconciles opening + net change = closing, transfers excluded', async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const j = buildJournal(db('LIVE', s.companyId));
  const cf = cashFlow(j, { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(cf.reconciles, true);
  assert.equal(cf.opening_cash, 0);
  const bankTotal = cashOnHand(j, '2027-03-31').total;
  assert.equal(cf.closing_cash, bankTotal);
  // Opening balances are financing (owner funds) in this derived view; loans in, repayment out.
  assert.equal(cf.financing.find((r) => r.code === '2400')?.amount, R(500_000 - 100_000));
  assert.ok(j.vouchers.filter((v) => v.type === 'TRANSFER').every((v) => v.lines.every((l) => isBank(l.account))));
});

test('period trial balance: opening + movement = closing; general ledger running balance', async () => {
  const s = await adminSession();
  const ids = await seedFinance(s.cookie);
  const j = buildJournal(db('LIVE', s.companyId));
  const tb = trialBalance(j, { from: '2026-05-01', to: '2026-05-31' });
  for (const r of tb.rows) assert.equal(r.opening_debit - r.opening_credit + r.period_debit - r.period_credit, r.closing_debit - r.closing_credit, r.code);
  const gl = generalLedger(j, `1100.${ids.A}`, { from: '2026-05-01', to: '2026-05-31' });
  assert.equal(gl.closing, gl.opening + gl.period_debit - gl.period_credit);
  assert.equal(gl.lines.at(-1).balance, gl.closing);
});
