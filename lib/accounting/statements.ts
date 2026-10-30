/** Financial statements over the derived journal. All amounts in paise. */
import { Journal, Voucher, CHART, isBank, natural, groupOf, type Group } from './journal';

export type Period = { from?: string; to?: string };
const inPeriod = (date: string, p: Period) => (!p.from || date >= p.from) && (!p.to || date <= p.to);
const before = (date: string, from?: string) => Boolean(from) && date < from!;

type Bal = { debit: number; credit: number };
function accumulate(j: Journal, filter: (v: Voucher) => boolean, keyOf: (account: string, party: string | null) => string = (a) => a) {
  const map = new Map<string, Bal>();
  for (const v of j.vouchers) {
    if (!filter(v)) continue;
    for (const l of v.lines) {
      const k = keyOf(l.account, l.party);
      const b = map.get(k) || { debit: 0, credit: 0 };
      b.debit += l.debit; b.credit += l.credit; map.set(k, b);
    }
  }
  return map;
}
const accountName = (j: Journal, code: string) => j.accounts.get(code)?.name || code;
const sortCodes = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function trialBalance(j: Journal, p: Period = {}) {
  const opening = accumulate(j, (v) => before(v.date, p.from));
  const period = accumulate(j, (v) => inPeriod(v.date, p));
  const codes = [...new Set([...opening.keys(), ...period.keys()])].sort(sortCodes);
  const rows = codes.map((code) => {
    const o = opening.get(code) || { debit: 0, credit: 0 }, m = period.get(code) || { debit: 0, credit: 0 };
    const closingNet = (o.debit + m.debit) - (o.credit + m.credit);
    return { code, name: accountName(j, code), group: groupOf(j, code), review: Boolean(j.accounts.get(code)?.review || j.accounts.get(code.split('.')[0])?.review),
      opening_debit: Math.max(0, o.debit - o.credit), opening_credit: Math.max(0, o.credit - o.debit), period_debit: m.debit, period_credit: m.credit,
      closing_debit: Math.max(0, closingNet), closing_credit: Math.max(0, -closingNet) };
  }).filter((r) => r.opening_debit || r.opening_credit || r.period_debit || r.period_credit);
  const totals = rows.reduce((t, r) => { for (const k of ['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'closing_debit', 'closing_credit'] as const) t[k] += r[k]; return t; }, { opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 0, closing_debit: 0, closing_credit: 0 });
  return { rows, totals, balanced: totals.closing_debit === totals.closing_credit && totals.period_debit === totals.period_credit };
}

export function generalLedger(j: Journal, account: string, p: Period = {}, party?: string | null, opts: { limit?: number; offset?: number } = {}) {
  const match = (code: string, pt: string | null) => (code === account || (account === '1100' && isBank(code))) && (!party || pt === party);
  let openingNet = 0; const lines: any[] = [];
  for (const v of j.vouchers) {
    for (const l of v.lines) {
      if (!match(l.account, l.party)) continue;
      if (before(v.date, p.from)) { openingNet += l.debit - l.credit; continue; }
      if (!inPeriod(v.date, p)) continue;
      lines.push({ date: v.date, voucher: v.id, type: v.type, ref: v.ref, narration: v.narration, party: l.party ? j.partyNames.get(l.party) || l.party : null, debit: l.debit, credit: l.credit, source: v.source });
    }
  }
  let running = openingNet;
  for (const l of lines) { running += l.debit - l.credit; l.balance = running; }
  const total = lines.length; const offset = opts.offset || 0; const limit = opts.limit ?? total;
  return { account, name: accountName(j, account), group: groupOf(j, account.split('.')[0] === '1100' ? '1100' : account), opening: openingNet, closing: running,
    period_debit: lines.reduce((s, l) => s + l.debit, 0), period_credit: lines.reduce((s, l) => s + l.credit, 0), total, lines: lines.slice(offset, offset + limit) };
}

/** Balance of each (account, party) pair up to a date. */
export function partyBalances(j: Journal, account: string, asOf?: string) {
  const m = accumulate(j, (v) => !asOf || v.date <= asOf, (a, pt) => (a === account ? `${pt}` : '__skip'));
  m.delete('__skip');
  return [...m.entries()].map(([party, b]) => ({ party, name: j.partyNames.get(party) || party, balance: natural(groupOf(j, account), b.debit, b.credit) }));
}

function sectionRows(j: Journal, bal: Map<string, Bal>, group: Group) {
  return [...bal.entries()].filter(([code]) => groupOf(j, code) === group).sort(([a], [b]) => sortCodes(a, b))
    .map(([code, b]) => ({ code, name: accountName(j, code), amount: natural(group, b.debit, b.credit), review: Boolean(j.accounts.get(code.split('.')[0])?.review) }))
    .filter((r) => r.amount !== 0);
}
const sum = (rows: Array<{ amount: number }>) => rows.reduce((s, r) => s + r.amount, 0);

export function incomeStatement(j: Journal, p: Period = {}) {
  const bal = accumulate(j, (v) => inPeriod(v.date, p));
  const income = sectionRows(j, bal, 'INCOME'), expense = sectionRows(j, bal, 'EXPENSE');
  const salesAccts = ['4100', '4200'], cogs = ['5100'];
  const revenue = sum(income.filter((r) => salesAccts.includes(r.code)));
  const cost = sum(expense.filter((r) => cogs.includes(r.code)));
  const totalIncome = sum(income), totalExpense = sum(expense);
  return { income, expense, revenue, cost_of_goods: cost, gross_profit: revenue - cost, total_income: totalIncome, total_expense: totalExpense, net_profit: totalIncome - totalExpense,
    gross_margin_pct: revenue ? Math.round((revenue - cost) / revenue * 10000) / 100 : 0, net_margin_pct: revenue ? Math.round((totalIncome - totalExpense) / revenue * 10000) / 100 : 0 };
}

export function balanceSheet(j: Journal, asOf: string) {
  const bal = accumulate(j, (v) => v.date <= asOf);
  // Bank sub-accounts are shown individually under Bank & Cash.
  const assets = sectionRows(j, bal, 'ASSET'), liabilities = sectionRows(j, bal, 'LIABILITY'), equity = sectionRows(j, bal, 'EQUITY');
  const pl = sum(sectionRows(j, bal, 'INCOME')) - sum(sectionRows(j, bal, 'EXPENSE'));
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = sum(equity) + pl;
  return { as_of: asOf, assets, liabilities, equity, profit_and_loss_to_date: pl, total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity, difference: totalAssets - totalLiabilities - totalEquity };
}

/** Direct-method cash flow. Bank-to-bank transfers are excluded; counter lines classified by account. */
export function cashFlow(j: Journal, p: Period = {}) {
  const classes = { operating: new Map<string, number>(), investing: new Map<string, number>(), financing: new Map<string, number>() } as Record<'operating' | 'investing' | 'financing', Map<string, number>>;
  let openingCash = 0, closingCash = 0;
  for (const v of j.vouchers) {
    const bankNet = v.lines.filter((l) => isBank(l.account)).reduce((s, l) => s + l.debit - l.credit, 0);
    if (v.date <= (p.to || '9999-12-31')) closingCash += bankNet;
    if (before(v.date, p.from)) openingCash += bankNet;
    if (!inPeriod(v.date, p) || bankNet === 0) continue;
    const counter = v.lines.filter((l) => !isBank(l.account));
    const counterNet = counter.reduce((s, l) => s + Math.abs(l.debit - l.credit), 0);
    if (!counterNet) continue;
    // Allocate the cash movement across the voucher's non-cash lines (largest-remainder, exact).
    let allocated = 0;
    counter.forEach((l, i) => {
      const weight = Math.abs(l.debit - l.credit);
      const share = i === counter.length - 1 ? bankNet - allocated : Math.round(bankNet * weight / counterNet);
      allocated += share;
      const cls = (CHART[l.account.split('.')[0]]?.cashflow || 'operating') as 'operating' | 'investing' | 'financing' | 'cash';
      const bucket = cls === 'cash' ? 'operating' : cls;
      const key = l.account;
      classes[bucket].set(key, (classes[bucket].get(key) || 0) + share);
    });
  }
  const rows = (m: Map<string, number>) => [...m.entries()].sort(([a], [b]) => sortCodes(a, b)).map(([code, amount]) => ({ code, name: accountName(j, code), amount })).filter((r) => r.amount !== 0);
  const operating = rows(classes.operating), investing = rows(classes.investing), financing = rows(classes.financing);
  const net = sum(operating) + sum(investing) + sum(financing);
  return { opening_cash: openingCash, operating, investing, financing, net_operating: sum(operating), net_investing: sum(investing), net_financing: sum(financing), net_change: net, closing_cash: closingCash, reconciles: openingCash + net === closingCash };
}

export function cashOnHand(j: Journal, asOf: string) {
  const bal = accumulate(j, (v) => v.date <= asOf);
  const rows = [...bal.entries()].filter(([code]) => isBank(code)).sort(([a], [b]) => sortCodes(a, b)).map(([code, b]) => ({ code, name: accountName(j, code), balance: b.debit - b.credit }));
  return { as_of: asOf, rows, total: rows.reduce((s, r) => s + r.balance, 0) };
}

export function monthlyProfit(j: Journal, p: Period = {}) {
  const months = new Map<string, { income: number; expense: number }>();
  for (const v of j.vouchers) {
    if (!inPeriod(v.date, p)) continue;
    const m = v.date.slice(0, 7);
    const row = months.get(m) || { income: 0, expense: 0 };
    for (const l of v.lines) { const g = groupOf(j, l.account); if (g === 'INCOME') row.income += l.credit - l.debit; if (g === 'EXPENSE') row.expense += l.debit - l.credit; }
    months.set(m, row);
  }
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, r]) => ({ month, income: r.income, expense: r.expense, profit: r.income - r.expense }));
}
