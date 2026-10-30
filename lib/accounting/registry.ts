/**
 * Report registry (v2.7.0). One entry per report card in the Reports hub.
 * Each report returns { data, table } — `table` is the generic tabular form used by CSV/XLSX/PDF export.
 */
import { buildJournal, Journal, CHART, isBank } from './journal';
import * as S from './statements';
import * as O from './operational';
import { financialYear } from '../money';

export type Col = { key: string; label: string; type?: 'money' | 'text' | 'number' | 'date' | 'pct' };
export type Table = { title: string; subtitle?: string; columns: Col[]; rows: any[]; totals?: any; notes?: string[]; sections?: Table[] };
export type Params = { from?: string; to?: string; as_of?: string; account?: string; party?: string; fy?: string; user?: string; entity?: string; limit?: number; offset?: number; weeks?: number };
export type Ctx = { d: any; params: Params; today: string; journal: () => Journal };
export type ReportDef = {
  id: string; title: string; group: string; description: string; icon: string;
  kind: 'statement' | 'management' | 'estimate' | 'statutory-support' | 'list' | 'control';
  permission: string[]; params: Array<keyof Params>;
  run: (ctx: Ctx) => { data: any; table: Table };
};

export const GROUPS = ['Company & Financial', 'Customers & Receivables', 'Vendors & Payables', 'Sales', 'Purchases', 'Inventory', 'Sales Tax (GST)', 'Accountant & Taxes', 'Lists', 'Combined / Multi-company'];

const M = (key: string, label: string): Col => ({ key, label, type: 'money' });
const T = (key: string, label: string): Col => ({ key, label });
const D = (key: string, label: string): Col => ({ key, label, type: 'date' });
const N = (key: string, label: string): Col => ({ key, label, type: 'number' });
function period(ctx: Ctx) {
  const fy = financialYear(ctx.today);
  return { from: ctx.params.from || fy.start, to: ctx.params.to || ctx.today };
}
const asOf = (ctx: Ctx) => ctx.params.as_of || ctx.params.to || ctx.today;
const sectionTable = (title: string, rows: any[], total: number, totalLabel = 'Total'): Table => ({ title, columns: [T('code', 'Code'), T('name', 'Account'), M('amount', 'Amount')], rows, totals: { name: totalLabel, amount: total } });

export function budgetVsActualData(ctx: Ctx) {
  const fy = ctx.params.fy || financialYear(ctx.params.from || ctx.today).label;
  const startYear = Number(fy.slice(0, 4));
  const months = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = m >= 4 ? startYear : startYear + 1; return `${y}-${String(m).padStart(2, '0')}`; });
  const budgets = ctx.d.prepare('SELECT account_code, month, amount FROM budgets WHERE fiscal_year=?').all(fy) as any[];
  const j = ctx.journal();
  const actual = new Map<string, number>();
  for (const v of j.vouchers) {
    const m = v.date.slice(0, 7); if (!months.includes(m)) continue;
    for (const l of v.lines) {
      const g = CHART[l.account.split('.')[0]]?.group; if (g !== 'INCOME' && g !== 'EXPENSE') continue;
      const amt = g === 'INCOME' ? l.credit - l.debit : l.debit - l.credit;
      actual.set(`${l.account}|${m}`, (actual.get(`${l.account}|${m}`) || 0) + amt);
    }
  }
  const codes = [...new Set([...budgets.map((b) => String(b.account_code)), ...[...actual.keys()].map((k) => k.split('|')[0])])].filter((c) => CHART[c]).sort();
  const budgetOf = (c: string, m: string) => Math.round(Number(budgets.find((b) => String(b.account_code) === c && b.month === m)?.amount || 0) * 100);
  const rows = codes.map((code) => {
    const byMonth = months.map((m) => ({ month: m, budget: budgetOf(code, m), actual: actual.get(`${code}|${m}`) || 0 }));
    const budget = byMonth.reduce((s, x) => s + x.budget, 0), act = byMonth.reduce((s, x) => s + x.actual, 0);
    const income = CHART[code].group === 'INCOME';
    return { code, name: CHART[code].name, group: CHART[code].group, budget, actual: act, variance: income ? act - budget : budget - act, variance_pct: budget ? Math.round((act - budget) / budget * 10000) / 100 : null, months: byMonth };
  });
  return { fiscal_year: fy, months, rows, has_budget: budgets.length > 0 };
}

export const REPORTS: ReportDef[] = [
  // ---------------- Company & Financial ----------------
  { id: 'balance-sheet', title: 'Balance Sheet', group: 'Company & Financial', icon: 'scale', kind: 'statement', permission: ['reports'], params: ['as_of'],
    description: 'Your financial position: assets, liabilities and equity as of a date.',
    run: (ctx) => { const bs = S.balanceSheet(ctx.journal(), asOf(ctx)); return { data: bs, table: { title: 'Balance Sheet', subtitle: `As of ${bs.as_of}`, columns: [], rows: [], sections: [sectionTable('Assets', bs.assets, bs.total_assets, 'Total assets'), sectionTable('Liabilities', bs.liabilities, bs.total_liabilities, 'Total liabilities'), sectionTable('Equity', [...bs.equity, { code: '', name: 'Profit & loss to date (not yet transferred)', amount: bs.profit_and_loss_to_date }], bs.total_equity, 'Total equity'), { title: 'Check', columns: [T('name', 'Item'), M('amount', 'Amount')], rows: [{ name: 'Liabilities + equity', amount: bs.total_liabilities + bs.total_equity }, { name: 'Difference (must be 0)', amount: bs.difference }] }], notes: ['Derived double-entry view (ADR-001). Accounts marked review need CA confirmation before statutory use.', 'Inventory is not carried in the ledger; see Inventory Valuation.'] } }; } },
  { id: 'income-statement', title: 'Income Statement', group: 'Company & Financial', icon: 'bars', kind: 'statement', permission: ['reports'], params: ['from', 'to'],
    description: 'Income, expenses and net profit or loss over a period.',
    run: (ctx) => { const p = period(ctx); const r = S.incomeStatement(ctx.journal(), p); return { data: { ...p, ...r }, table: { title: 'Income Statement', subtitle: `${p.from} to ${p.to}`, columns: [], rows: [], sections: [sectionTable('Income', r.income, r.total_income, 'Total income'), sectionTable('Expenses', r.expense, r.total_expense, 'Total expenses'), { title: 'Result', columns: [T('name', 'Measure'), M('amount', 'Amount')], rows: [{ name: 'Revenue (sales)', amount: r.revenue }, { name: 'Cost of goods (purchases)', amount: r.cost_of_goods }, { name: 'Gross profit', amount: r.gross_profit }, { name: 'Net profit / (loss)', amount: r.net_profit }] }], notes: ['Purchases are expensed when posted; closing stock is not deducted (see Inventory Valuation).'] } }; } },
  { id: 'profit-insights', title: 'Profit Insights', group: 'Company & Financial', icon: 'sparkle', kind: 'management', permission: ['reports'], params: ['from', 'to'],
    description: 'What moved your profit versus the prior period — top customers, items and expense categories.',
    run: (ctx) => {
      const p = period(ctx); const j = ctx.journal(); const len = Date.parse(p.to) - Date.parse(p.from);
      const prev = { from: new Date(Date.parse(p.from) - len - 86400000).toISOString().slice(0, 10), to: new Date(Date.parse(p.from) - 86400000).toISOString().slice(0, 10) };
      const cur = S.incomeStatement(j, p), pri = S.incomeStatement(j, prev);
      const customers = O.salesByCustomer(ctx.d, p).rows.slice(0, 10), items = O.salesByItem(ctx.d, p).rows.slice(0, 10);
      const drivers = [...cur.income, ...cur.expense].map((r) => { const before = [...pri.income, ...pri.expense].find((x) => x.code === r.code)?.amount || 0; const isExp = CHART[r.code.split('.')[0]]?.group === 'EXPENSE'; return { code: r.code, name: r.name, current: r.amount, prior: before, effect_on_profit: isExp ? -(r.amount - before) : r.amount - before }; }).sort((a, b) => Math.abs(b.effect_on_profit) - Math.abs(a.effect_on_profit));
      const monthly = S.monthlyProfit(j, p);
      return { data: { period: p, prior: prev, current: cur, previous: pri, drivers, customers, items, monthly }, table: { title: 'Profit Insights', subtitle: `${p.from} to ${p.to} vs ${prev.from} to ${prev.to}`, columns: [], rows: [], sections: [
        { title: 'Profit change drivers', columns: [T('name', 'Account'), M('prior', 'Prior'), M('current', 'Current'), M('effect_on_profit', 'Effect on profit')], rows: drivers },
        { title: 'Top customers by gross profit', columns: [T('customer', 'Customer'), M('sales', 'Sales'), M('gross_profit', 'Gross profit'), { key: 'margin_pct', label: 'Margin %', type: 'pct' }], rows: [...customers].sort((a, b) => b.gross_profit - a.gross_profit) },
        { title: 'Top items', columns: [T('item', 'Item'), M('sales', 'Sales'), M('gross_profit', 'Gross profit')], rows: items },
        { title: 'Monthly profit', columns: [T('month', 'Month'), M('income', 'Income'), M('expense', 'Expense'), M('profit', 'Profit')], rows: monthly }], notes: [`Net profit ${cur.net_profit >= pri.net_profit ? 'improved' : 'declined'} versus the prior period of equal length.`] } };
    } },
  { id: 'cash-flow', title: 'Cash Flow', group: 'Company & Financial', icon: 'cash', kind: 'statement', permission: ['reports'], params: ['from', 'to'],
    description: 'Net change in cash from operating, investing and financing activity.',
    run: (ctx) => { const p = period(ctx); const r = S.cashFlow(ctx.journal(), p); const cf = (t: string, rows: any[], tot: number) => sectionTable(t, rows, tot, `Net ${t.toLowerCase()}`); return { data: { ...p, ...r }, table: { title: 'Cash Flow (direct method)', subtitle: `${p.from} to ${p.to}`, columns: [], rows: [], sections: [cf('Operating activities', r.operating, r.net_operating), cf('Investing activities', r.investing, r.net_investing), cf('Financing activities', r.financing, r.net_financing), { title: 'Cash', columns: [T('name', 'Item'), M('amount', 'Amount')], rows: [{ name: 'Opening cash', amount: r.opening_cash }, { name: 'Net change', amount: r.net_change }, { name: 'Closing cash', amount: r.closing_cash }] }], notes: ['Transfers between your own bank/cash accounts are excluded.', 'Interest paid is classified as financing; opening balances and capital as financing.'] } }; } },
  { id: 'cash-flow-forecast', title: 'Cash Flow Forecast', group: 'Company & Financial', icon: 'trend', kind: 'estimate', permission: ['reports'], params: ['as_of', 'weeks'],
    description: 'Where cash is headed over the next quarter from open bills, invoices and loan interest — with a low-cash alert.',
    run: (ctx) => { const a = asOf(ctx); const cash = S.cashOnHand(ctx.journal(), a).total; const r = O.cashForecast(ctx.d, a, cash, Math.min(26, Math.max(4, Number(ctx.params.weeks || 13)))); const low = r.weeks.find((w) => w.closing < 0); return { data: { ...r, low_cash_week: low || null }, table: { title: 'Cash Flow Forecast', subtitle: `From ${a}${low ? ` — LOW CASH ALERT: negative in week ${low.week}` : ''}`, columns: [N('week', 'Week'), D('from', 'From'), D('to', 'To'), M('inflow', 'Expected in'), M('outflow', 'Expected out'), M('net', 'Net'), M('closing', 'Projected cash')], rows: r.weeks, notes: [...r.notes, `Overdue receivables not assumed: ${(r.overdue_inflows / 100).toFixed(2)}; overdue payables/interest not assumed: ${(r.overdue_outflows / 100).toFixed(2)}.`] } }; } },
  { id: 'cash-on-hand', title: 'Cash on Hand', group: 'Company & Financial', icon: 'wallet', kind: 'statement', permission: ['reports', 'accounts'], params: ['as_of'],
    description: 'Every bank and cash account that makes up your cash balance.',
    run: (ctx) => { const r = S.cashOnHand(ctx.journal(), asOf(ctx)); return { data: r, table: { title: 'Cash on Hand', subtitle: `As of ${r.as_of}`, columns: [T('name', 'Account'), M('balance', 'Balance')], rows: r.rows, totals: { name: 'Total', balance: r.total } } }; } },
  { id: 'budget-vs-actual', title: 'Budget vs. Actual', group: 'Company & Financial', icon: 'calculator', kind: 'management', permission: ['reports'], params: ['fy'],
    description: 'Actual results against your budget targets, with variances by account.',
    run: (ctx) => { const r = budgetVsActualData(ctx); return { data: r, table: { title: 'Budget vs. Actual', subtitle: `FY ${r.fiscal_year}`, columns: [T('code', 'Code'), T('name', 'Account'), M('budget', 'Budget'), M('actual', 'Actual'), M('variance', 'Favourable / (adverse)'), { key: 'variance_pct', label: 'Variance %', type: 'pct' }], rows: r.rows, notes: r.has_budget ? ['Variance is favourable when income exceeds or expense stays below budget.'] : ['No budget entered for this fiscal year. Enter monthly targets in Budget Overview.'] } }; } },
  { id: 'budget-overview', title: 'Budget Overview', group: 'Company & Financial', icon: 'table', kind: 'management', permission: ['reports'], params: ['fy'],
    description: 'The monthly target amounts entered for a budget.',
    run: (ctx) => { const r = budgetVsActualData(ctx); const rows = r.rows.map((x) => ({ code: x.code, name: x.name, ...Object.fromEntries(x.months.map((m) => [m.month, m.budget])), total: x.budget })); return { data: r, table: { title: 'Budget Overview', subtitle: `FY ${r.fiscal_year}`, columns: [T('code', 'Code'), T('name', 'Account'), ...r.months.map((m) => M(m, m)), M('total', 'Total')], rows } }; } },
  { id: 'budget-vs-actual-monthly', title: 'Budget vs. Actual by Month', group: 'Company & Financial', icon: 'calendar', kind: 'management', permission: ['reports'], params: ['fy'],
    description: 'Month-by-month actual, budget and variance across the fiscal year.',
    run: (ctx) => { const r = budgetVsActualData(ctx); const rows = r.rows.flatMap((x) => [{ code: x.code, name: `${x.name} — budget`, ...Object.fromEntries(x.months.map((m) => [m.month, m.budget])) }, { code: x.code, name: `${x.name} — actual`, ...Object.fromEntries(x.months.map((m) => [m.month, m.actual])) }, { code: x.code, name: `${x.name} — variance`, ...Object.fromEntries(x.months.map((m) => [m.month, m.actual - m.budget])) }]); return { data: r, table: { title: 'Budget vs. Actual by Month', subtitle: `FY ${r.fiscal_year}`, columns: [T('code', 'Code'), T('name', 'Line'), ...r.months.map((m) => M(m, m))], rows } }; } },
  { id: 'management-package', title: 'Management Reports', group: 'Company & Financial', icon: 'pages', kind: 'management', permission: ['reports'], params: ['from', 'to'],
    description: 'A bundled, professional PDF package with cover page and table of contents.',
    run: (ctx) => ({ data: { pdf: true, includes: MANAGEMENT_PACKAGE }, table: { title: 'Management Reports', columns: [T('id', 'Report')], rows: MANAGEMENT_PACKAGE.map((id) => ({ id: REPORTS.find((r) => r.id === id)?.title || id })), notes: ['Download as PDF to receive the bundled package.'] } }) },

  // ---------------- Customers & Receivables ----------------
  { id: 'ar-aging', title: 'AR Aging', group: 'Customers & Receivables', icon: 'clock', kind: 'management', permission: ['reports', 'receivables'], params: ['as_of'],
    description: 'Outstanding customer balances bucketed by how overdue they are.',
    run: (ctx) => { const r = O.arAging(ctx.d, asOf(ctx)); return { data: r, table: { title: 'AR Aging', subtitle: `As of ${r.as_of}`, columns: [T('party', 'Customer'), M('current', 'Current'), M('d1_30', '1–30'), M('d31_60', '31–60'), M('d61_90', '61–90'), M('d90_plus', '90+'), M('total', 'Total')], rows: r.parties, totals: { party: 'Total', ...r.totals }, notes: r.notes } }; } },
  { id: 'open-invoices', title: 'Open Invoices', group: 'Customers & Receivables', icon: 'doc', kind: 'management', permission: ['reports', 'receivables'], params: ['as_of'],
    description: 'Every unpaid financing bill and sales invoice with its outstanding balance.',
    run: (ctx) => { const r = O.openInvoices(ctx.d, asOf(ctx)); return { data: r, table: { title: 'Open Invoices', subtitle: `As of ${r.as_of}`, columns: [T('kind', 'Type'), T('doc_no', 'Document'), D('doc_date', 'Date'), D('due_date', 'Due'), T('party', 'Customer'), M('amount', 'Amount'), M('received', 'Received'), M('outstanding', 'Outstanding'), N('days_past_due', 'Days overdue')], rows: r.rows, totals: { kind: 'Total', outstanding: r.total }, notes: r.notes } }; } },
  { id: 'unattributed-ar', title: 'Unattributed AR', group: 'Customers & Receivables', icon: 'question', kind: 'control', permission: ['reports', 'money-in'], params: ['from', 'to'],
    description: 'Money received that is not linked to any bill or invoice (advances, other receipts, refunds).',
    run: (ctx) => { const r = O.unattributedReceipts(ctx.d, ctx.params); return { data: r, table: { title: 'Unattributed Receipts', columns: [T('receipt_no', 'Receipt'), D('receipt_date', 'Date'), T('receipt_type', 'Type'), T('party', 'Party'), T('narration', 'Narration'), M('amount', 'Amount')], rows: r.rows, totals: { receipt_no: 'Total', amount: r.total }, notes: r.notes } }; } },

  // ---------------- Vendors & Payables ----------------
  { id: 'ap-aging', title: 'AP Aging', group: 'Vendors & Payables', icon: 'clock', kind: 'management', permission: ['reports', 'payments'], params: ['as_of'],
    description: 'Outstanding vendor bills bucketed by how overdue they are.',
    run: (ctx) => { const r = O.apAging(ctx.d, asOf(ctx)); return { data: r, table: { title: 'AP Aging', subtitle: `As of ${r.as_of}`, columns: [T('party', 'Vendor'), M('current', 'Current'), M('d1_30', '1–30'), M('d31_60', '31–60'), M('d61_90', '61–90'), M('d90_plus', '90+'), M('total', 'Total')], rows: r.parties, totals: { party: 'Total', ...r.totals }, notes: [...r.notes, `Unapplied vendor payments (advances): ${(r.unapplied_total / 100).toFixed(2)}`] } }; } },
  { id: 'open-bills', title: 'Open Bills', group: 'Vendors & Payables', icon: 'doc', kind: 'management', permission: ['reports', 'payments', 'purchase'], params: ['as_of'],
    description: 'Every unpaid vendor bill and its outstanding balance.',
    run: (ctx) => { const r = O.openBills(ctx.d, asOf(ctx)); return { data: r, table: { title: 'Open Bills', subtitle: `As of ${r.as_of}`, columns: [T('doc_no', 'Sample / bill'), T('invoice_no', 'Vendor invoice'), D('doc_date', 'Date'), D('due_date', 'Due'), T('party', 'Vendor'), M('amount', 'Net payable'), M('paid', 'Paid'), M('outstanding', 'Outstanding'), N('days_past_due', 'Days overdue')], rows: r.rows, totals: { doc_no: 'Total', outstanding: r.total }, notes: r.notes } }; } },
  { id: 'vendor-activity', title: 'Vendor Activity', group: 'Vendors & Payables', icon: 'list', kind: 'management', permission: ['reports', 'payments'], params: ['from', 'to'],
    description: 'Opening balance, bills, payments, TDS and closing balance for every vendor.',
    run: (ctx) => { const p = period(ctx); const r = O.vendorActivity(ctx.d, p); return { data: r, table: { title: 'Vendor Activity', subtitle: `${p.from} to ${p.to}`, columns: [T('name', 'Vendor'), T('pan', 'PAN'), M('opening', 'Opening'), N('bills', 'Bills'), M('purchases', 'Purchases'), M('payments', 'Payments (gross)'), M('tds', 'TDS deducted'), M('closing', 'Closing')], rows: r.rows, notes: r.notes } }; } },
  { id: 'tds-summary', title: 'TDS Summary', group: 'Vendors & Payables', icon: 'id', kind: 'statutory-support', permission: ['reports', 'payments'], params: ['from', 'to'],
    description: 'TDS deducted on vendor payments by quarter and TDS credits deducted by customers (Indian equivalent of a 1099 summary).',
    run: (ctx) => { const p = period(ctx); const r = O.tdsSummary(ctx.d, p); return { data: r, table: { title: 'TDS Summary', subtitle: `${p.from} to ${p.to}`, columns: [], rows: [], sections: [
      { title: 'TDS deducted on payments', columns: [T('quarter', 'Quarter'), D('payment_date', 'Date'), T('payment_no', 'Payment'), T('party', 'Payee'), T('pan', 'PAN'), T('tds_rule', 'Rule / section'), M('tds_base', 'Base'), { key: 'tds_rate', label: 'Rate %', type: 'number' }, M('tds_amount', 'TDS')], rows: r.deducted, totals: { quarter: 'Total', tds_amount: r.deducted_total } },
      { title: 'TDS credits receivable (deducted by customers)', columns: [T('quarter', 'Quarter'), D('transaction_date', 'Date'), T('bill_no', 'Bill'), T('party', 'Deductor'), T('pan', 'PAN'), T('section', 'Section'), M('amount', 'TDS')], rows: r.credits_receivable, totals: { quarter: 'Total', amount: r.credits_total } }], notes: r.notes } }; } },

  // ---------------- Sales ----------------
  { id: 'sales-by-customer', title: 'Sales by Customer', group: 'Sales', icon: 'rupee', kind: 'management', permission: ['reports', 'receivables'], params: ['from', 'to'],
    description: 'Revenue, cost and gross profit per customer over a period.',
    run: (ctx) => { const p = period(ctx); const r = O.salesByCustomer(ctx.d, p); return { data: r, table: { title: 'Sales by Customer', subtitle: `${p.from} to ${p.to}`, columns: [T('customer', 'Customer'), T('source', 'Source'), N('docs', 'Documents'), M('sales', 'Sales'), M('cost', 'Cost'), M('gross_profit', 'Gross profit'), { key: 'margin_pct', label: 'Margin %', type: 'pct' }], rows: r.rows, totals: { customer: 'Total', sales: r.total_sales, cost: r.total_cost, gross_profit: r.total_sales - r.total_cost }, notes: r.notes } }; } },
  { id: 'customer-detail', title: 'Sales by Customer (Detail)', group: 'Sales', icon: 'rupee', kind: 'management', permission: ['reports', 'receivables'], params: ['party', 'from', 'to'],
    description: 'Every sales document and receipt for one customer over a period.',
    run: (ctx) => { if (!ctx.params.party) { const list = O.salesByCustomer(ctx.d, period(ctx)).rows; return { data: { customers: list }, table: { title: 'Sales by Customer (Detail)', subtitle: 'Choose a customer', columns: [T('customer', 'Customer'), T('key', 'Key'), M('sales', 'Sales')], rows: list } }; } const r = O.customerDetail(ctx.d, ctx.params.party, ctx.params); return { data: r, table: { title: `Customer detail — ${r.customer}`, columns: [], rows: [], sections: [{ title: 'Documents', columns: [T('doc_no', 'Document'), D('doc_date', 'Date'), T('status', 'Status'), M('amount', 'Amount'), M('received', 'Received')], rows: r.documents }, { title: 'Receipts', columns: [D('date', 'Date'), T('ref', 'Reference'), M('amount', 'Amount')], rows: r.receipts }] } }; } },
  { id: 'sales-by-item', title: 'Sales by Item', group: 'Sales', icon: 'rupee', kind: 'management', permission: ['reports', 'receivables'], params: ['from', 'to'],
    description: 'Revenue and quantity sold per item over a period.',
    run: (ctx) => { const p = period(ctx); const r = O.salesByItem(ctx.d, p); return { data: r, table: { title: 'Sales by Item', subtitle: `${p.from} to ${p.to}`, columns: [T('item', 'Item'), T('hsn', 'HSN'), T('source', 'Source'), N('docs', 'Documents'), N('qty', 'Quantity'), T('unit', 'Unit'), M('sales', 'Sales'), M('gross_profit', 'Gross profit')], rows: r.rows, notes: r.notes } }; } },
  { id: 'sales-by-rep', title: 'Sales by Rep (Broker)', group: 'Sales', icon: 'rupee', kind: 'management', permission: ['reports', 'receivables'], params: ['from', 'to'],
    description: 'Financing sales grouped by the broker recorded on the purchase.',
    run: (ctx) => { const p = period(ctx); const r = O.salesByRepresentative(ctx.d, p); return { data: r, table: { title: 'Sales by Representative (Broker)', subtitle: `${p.from} to ${p.to}`, columns: [T('representative', 'Broker / representative'), N('docs', 'Bills'), M('sales', 'Sales'), M('gross_profit', 'Gross profit')], rows: r.rows, notes: r.notes } }; } },

  // ---------------- Purchases ----------------
  { id: 'purchases-by-vendor', title: 'Purchases by Vendor', group: 'Purchases', icon: 'cart', kind: 'management', permission: ['reports', 'purchase'], params: ['from', 'to'],
    description: 'Spend per vendor over a period, after deductions.',
    run: (ctx) => { const p = period(ctx); const r = O.purchasesByVendor(ctx.d, p); return { data: r, table: { title: 'Purchases by Vendor', subtitle: `${p.from} to ${p.to}`, columns: [T('vendor', 'Vendor'), T('gst', 'GSTIN'), N('bills', 'Bills'), N('qty', 'Net weight'), M('gross', 'Gross'), M('deductions', 'Deductions'), M('net', 'Net payable'), M('gst_amount', 'GST (recorded)')], rows: r.rows, totals: { vendor: 'Total', net: r.total_net }, notes: r.notes } }; } },
  { id: 'purchases-by-item', title: 'Purchases by Item', group: 'Purchases', icon: 'cart', kind: 'management', permission: ['reports', 'purchase'], params: ['from', 'to'],
    description: 'Spend and quantity purchased per item over a period.',
    run: (ctx) => { const p = period(ctx); const r = O.purchasesByItem(ctx.d, p); return { data: r, table: { title: 'Purchases by Item', subtitle: `${p.from} to ${p.to}`, columns: [T('item', 'Item'), T('hsn', 'HSN'), N('bills', 'Bills'), N('qty', 'Quantity (KG)'), { key: 'avg_rate', label: 'Avg rate', type: 'number' }, M('gross', 'Gross'), M('net', 'Net payable')], rows: r.rows, notes: r.notes } }; } },
  { id: 'open-purchase-orders', title: 'Open Purchase Orders', group: 'Purchases', icon: 'clipboard', kind: 'management', permission: ['reports', 'sauda', 'purchase'], params: ['as_of'],
    description: 'Sauda bookings not yet fully received.',
    run: (ctx) => { const r = O.openPurchaseOrders(ctx.d, asOf(ctx)); return { data: r, table: { title: 'Open Purchase Orders (Sauda)', subtitle: `As of ${r.as_of}`, columns: [T('sauda_no', 'Sauda'), D('sauda_date', 'Date'), T('supplier', 'Supplier'), T('buyer', 'Buyer'), T('commodity', 'Commodity'), N('quantity', 'Booked'), N('allocated', 'Received'), N('open_quantity', 'Open'), T('unit', 'Unit'), { key: 'purchase_rate', label: 'Rate', type: 'number' }, M('open_value', 'Open value'), D('delivery_date', 'Delivery')], rows: r.rows, totals: { sauda_no: 'Total', open_value: r.total_value }, notes: r.notes } }; } },

  // ---------------- Inventory ----------------
  { id: 'stock-status', title: 'Stock Status', group: 'Inventory', icon: 'box', kind: 'management', permission: ['reports', 'godowns'], params: [],
    description: 'On-hand quantities by godown and commodity.',
    run: (ctx) => { const r = O.stockStatus(ctx.d); return { data: r, table: { title: 'Stock Status', columns: [T('godown', 'Godown'), T('commodity', 'Commodity'), T('unit', 'Unit'), N('lots', 'Lots'), N('qty_in', 'In'), N('qty_out', 'Out'), N('balance', 'On hand')], rows: r.rows, notes: r.notes } }; } },
  { id: 'inventory-valuation', title: 'Inventory Valuation', group: 'Inventory', icon: 'cube', kind: 'management', permission: ['reports', 'godowns'], params: [],
    description: 'Current inventory value from remaining purchase lots (specific identification).',
    run: (ctx) => { const r = O.inventoryValuation(ctx.d); return { data: r, table: { title: 'Inventory Valuation', columns: [T('batch_no', 'Lot'), T('godown', 'Godown'), T('commodity', 'Commodity'), T('sample_no', 'Purchase'), D('purchase_date', 'Date'), N('remaining', 'Remaining'), T('unit', 'Unit'), { key: 'unit_cost_gross', label: 'Rate', type: 'number' }, M('value_at_rate', 'Value at rate'), M('value_at_net_cost', 'Value at net cost')], rows: r.rows, totals: { batch_no: 'Total', value_at_rate: r.total_at_rate, value_at_net_cost: r.total_at_net_cost }, notes: r.notes } }; } },

  // ---------------- GST ----------------
  { id: 'gst-sales-tax', title: 'Sales Tax (GST)', group: 'Sales Tax (GST)', icon: 'percent', kind: 'statutory-support', permission: ['reports', 'gst'], params: ['from', 'to'],
    description: 'GST collected on sales and input GST recorded on purchases for the period.',
    run: (ctx) => { const p = period(ctx); const out = O.gstOutward(ctx.d, p); const inp = O.gstInward(ctx.d, p); return { data: { outward: out, inward: inp }, table: { title: 'Sales Tax (GST)', subtitle: `${p.from} to ${p.to}`, columns: [], rows: [], sections: [
      { title: 'Outward supplies (sales invoices)', columns: [T('invoice_no', 'Invoice'), D('invoice_date', 'Date'), T('customer_name', 'Customer'), T('customer_gstin', 'GSTIN'), T('section', 'B2B/B2C'), T('hsn', 'HSN'), { key: 'gst_rate', label: 'Rate %', type: 'number' }, M('taxable', 'Taxable'), M('cgst', 'CGST'), M('sgst', 'SGST'), M('igst', 'IGST'), M('total_value', 'Total')], rows: out.invoices, totals: { invoice_no: 'Total', ...out.totals } },
      { title: 'HSN summary', columns: [T('key', 'HSN'), N('count', 'Invoices'), M('taxable', 'Taxable'), M('cgst', 'CGST'), M('sgst', 'SGST'), M('igst', 'IGST')], rows: out.by_hsn },
      { title: 'Input tax on purchases', columns: [T('sample_no', 'Purchase'), T('invoice_no', 'Vendor invoice'), D('purchase_date', 'Date'), T('vendor', 'Vendor'), T('vendor_gstin', 'GSTIN'), M('gst_taxable', 'Taxable'), M('cgst', 'CGST'), M('sgst', 'SGST'), M('igst', 'IGST')], rows: inp.rows, totals: { sample_no: 'Total', gst_taxable: inp.totals.taxable, cgst: inp.totals.cgst, sgst: inp.totals.sgst, igst: inp.totals.igst } }], notes: [...out.notes, ...inp.notes] } }; } },
  { id: 'gst-returns', title: 'Tax Returns (GSTR-1 / 3B draft)', group: 'Sales Tax (GST)', icon: 'filedoc', kind: 'statutory-support', permission: ['reports', 'gst'], params: ['from', 'to'],
    description: 'Draft GSTR-1 and GSTR-3B style summaries for review before filing on the GST portal.',
    run: (ctx) => { const p = period(ctx); const r = O.gstSummary(ctx.d, p); const out = O.gstOutward(ctx.d, p); return { data: { ...r, gstr1_by_rate: out.by_rate }, table: { title: 'GST Return Drafts', subtitle: `${p.from} to ${p.to}`, columns: [], rows: [], sections: [
      { title: 'GSTR-1 — outward supplies by rate and section', columns: [T('key', 'Rate · section'), N('count', 'Invoices'), M('taxable', 'Taxable'), M('cgst', 'CGST'), M('sgst', 'SGST'), M('igst', 'IGST')], rows: out.by_rate },
      { title: 'GSTR-3B — estimated liability', columns: [T('head', 'Head'), M('output', 'Output tax'), M('input', 'ITC (vendor GSTIN present)'), M('net', 'Net payable (estimate)')], rows: (['cgst', 'sgst', 'igst'] as const).map((h) => ({ head: h.toUpperCase(), output: (r.output as any)[h], input: (r.input_with_gstin as any)[h], net: (r.net_payable_estimate as any)[h] })) }], notes: r.notes } }; } },

  // ---------------- Accountant & Taxes ----------------
  { id: 'trial-balance', title: 'Trial Balance', group: 'Accountant & Taxes', icon: 'scale', kind: 'statement', permission: ['reports', 'ledger'], params: ['from', 'to'],
    description: 'Debit and credit balance of every account, with opening, period movement and closing.',
    run: (ctx) => { const p = period(ctx); const r = S.trialBalance(ctx.journal(), p); return { data: { ...p, ...r }, table: { title: 'Trial Balance', subtitle: `${p.from} to ${p.to}${r.balanced ? '' : ' — NOT BALANCED'}`, columns: [T('code', 'Code'), T('name', 'Account'), M('opening_debit', 'Opening Dr'), M('opening_credit', 'Opening Cr'), M('period_debit', 'Debit'), M('period_credit', 'Credit'), M('closing_debit', 'Closing Dr'), M('closing_credit', 'Closing Cr')], rows: r.rows, totals: { name: 'Total', ...r.totals } } }; } },
  { id: 'general-ledger', title: 'General Ledger', group: 'Accountant & Taxes', icon: 'book', kind: 'statement', permission: ['reports', 'ledger'], params: ['account', 'party', 'from', 'to', 'limit', 'offset'],
    description: 'Every posted transaction, account by account, with running balances.',
    run: (ctx) => {
      const p = period(ctx); const j = ctx.journal();
      const codes = ctx.params.account ? [ctx.params.account] : [...new Set(j.vouchers.flatMap((v) => v.lines.map((l) => l.account)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      const ledgers = codes.map((c) => S.generalLedger(j, c, p, ctx.params.party || null, { limit: ctx.params.account ? Math.min(2000, ctx.params.limit || 500) : 200, offset: ctx.params.offset || 0 }));
      return { data: { ...p, ledgers }, table: { title: 'General Ledger', subtitle: `${p.from} to ${p.to}`, columns: [], rows: [], sections: ledgers.map((l) => { const sign = l.group === 'ASSET' || l.group === 'EXPENSE' ? 1 : -1; const side = sign === 1 ? 'Dr' : 'Cr'; return { title: `${l.account} ${l.name}`, columns: [D('date', 'Date'), T('type', 'Type'), T('ref', 'Reference'), T('party', 'Party'), T('narration', 'Narration'), M('debit', 'Debit'), M('credit', 'Credit'), M('balance', `Balance (${side})`)], rows: [{ narration: 'Opening balance', balance: l.opening * sign }, ...l.lines.map((x: any) => ({ ...x, balance: x.balance * sign }))], totals: { narration: `Closing (${l.total} entries)`, debit: l.period_debit, credit: l.period_credit, balance: l.closing * sign } }; }) } };
    } },
  { id: 'audit-logs', title: 'Audit Logs', group: 'Accountant & Taxes', icon: 'shield', kind: 'control', permission: ['reports'], params: ['from', 'to', 'user', 'entity', 'limit', 'offset'],
    description: 'Trail of financial mutations and administrative activity in this organization.',
    run: (ctx) => { const r = O.auditLog(ctx.d, ctx.params); return { data: r, table: { title: 'Audit Logs', subtitle: `${r.total} entries`, columns: [T('created_at', 'When (UTC)'), T('username', 'User'), T('action', 'Action'), T('entity', 'Entity'), T('entity_id', 'ID'), T('details', 'Details')], rows: r.rows } }; } },
  { id: 'reconciliation', title: 'Ledger Reconciliation', group: 'Accountant & Taxes', icon: 'check', kind: 'control', permission: ['reports'], params: ['as_of'],
    description: 'Checks that the derived ledger agrees with every source register, plus all exceptions.',
    run: (ctx) => { const r = reconciliation(ctx); return { data: r, table: { title: 'Ledger Reconciliation', subtitle: `As of ${r.as_of} — ${r.passed ? 'ALL CHECKS PASSED' : 'DIFFERENCES FOUND'}`, columns: [], rows: [], sections: [{ title: 'Checks', columns: [T('check', 'Check'), M('ledger', 'Ledger'), M('source', 'Source register'), M('difference', 'Difference'), T('status', 'Status')], rows: r.checks }, { title: 'Exceptions', columns: [T('severity', 'Severity'), T('code', 'Code'), T('message', 'Message'), M('amount', 'Amount')], rows: r.exceptions }] } }; } },

  // ---------------- Lists ----------------
  { id: 'account-list', title: 'Account List', group: 'Lists', icon: 'book', kind: 'list', permission: ['reports'], params: ['as_of'],
    description: 'Every account in the chart with its type and balance.',
    run: (ctx) => { const j = ctx.journal(); const tb = S.trialBalance(j, { to: asOf(ctx) }); const rows = [...j.accounts.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })).map((a) => { const r = tb.rows.find((x) => x.code === a.code); return { code: a.code, name: a.name, group: a.group, review: a.review ? 'Review' : '', balance: r ? r.closing_debit - r.closing_credit : 0 }; }); return { data: { rows }, table: { title: 'Account List', columns: [T('code', 'Code'), T('name', 'Account'), T('group', 'Type'), T('review', 'Classification'), M('balance', 'Balance (Dr + / Cr −)')], rows } }; } },
  { id: 'customer-contacts', title: 'Customer Contact List', group: 'Lists', icon: 'users', kind: 'list', permission: ['reports', 'parties'], params: [],
    description: 'Customer names, contact details, GSTIN/PAN and open balances.',
    run: (ctx) => { const r = O.contactList(ctx.d, 'customer'); const open = O.openInvoices(ctx.d, ctx.today).rows; const rows = r.rows.map((c: any) => ({ ...c, open_balance: open.filter((o) => o.party_key === (c.id ? `P${c.id}` : `C:${c.name}`)).reduce((s, o) => s + o.outstanding, 0) })); return { data: { rows }, table: { title: 'Customer Contact List', columns: [T('name', 'Customer'), T('contact', 'Phone'), T('email', 'Email'), T('address', 'Address'), T('gst', 'GSTIN'), T('pan', 'PAN'), M('open_balance', 'Open balance')], rows } }; } },
  { id: 'vendor-contacts', title: 'Vendor Contact List', group: 'Lists', icon: 'store', kind: 'list', permission: ['reports', 'parties'], params: [],
    description: 'Vendor names, contact details, GSTIN/PAN and open balances.',
    run: (ctx) => { const r = O.contactList(ctx.d, 'vendor'); const open = O.openBills(ctx.d, ctx.today).rows; const rows = r.rows.map((c: any) => ({ ...c, open_balance: open.filter((o) => o.party_key === `P${c.id}`).reduce((s, o) => s + o.outstanding, 0) })); return { data: { rows }, table: { title: 'Vendor Contact List', columns: [T('name', 'Vendor'), T('party_type', 'Type'), T('contact', 'Phone'), T('email', 'Email'), T('address', 'Address'), T('gst', 'GSTIN'), T('pan', 'PAN'), M('open_balance', 'Open bills')], rows } }; } },
];

/** Report Groups is multi-organization and handled by /api/reports/group (needs other org files). */
export const GROUP_REPORT_META = { id: 'report-groups', title: 'Report Groups', group: 'Combined / Multi-company', icon: 'building', kind: 'statement', permission: ['reports', 'dashboard'], params: ['from', 'to', 'as_of'], description: 'Consolidated Trial Balance, Balance Sheet and Income Statement across organizations you can access.' };
export const MANAGEMENT_PACKAGE = ['balance-sheet', 'income-statement', 'cash-flow', 'profit-insights', 'ar-aging', 'ap-aging', 'cash-flow-forecast', 'trial-balance'];

export function reconciliation(ctx: Ctx) {
  const a = asOf(ctx); const j = ctx.journal(); const d = ctx.d;
  const tb = S.trialBalance(j, { to: a });
  const bal = (code: string) => { const r = tb.rows.find((x) => x.code === code); return r ? r.closing_debit - r.closing_credit : 0; };
  const P = (v: any) => Math.round(Number(v || 0) * 100);
  const checks: any[] = [];
  const add = (check: string, ledger: number, source: number) => checks.push({ check, ledger, source, difference: ledger - source, status: ledger === source ? 'OK' : 'DIFFERENCE' });
  for (const acc of d.prepare('SELECT id, account_name, opening_balance FROM company_accounts').all() as any[]) {
    const src = P(acc.opening_balance) + P((d.prepare(`SELECT COALESCE(SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END),0) v FROM account_transactions WHERE account_id=? AND transaction_date<=?`).get(acc.id, a) as any).v);
    add(`Bank/cash: ${acc.account_name}`, bal(`1100.${acc.id}`), src);
  }
  add('Financing receivables (open bills)', bal('1200'), O.openInvoices(d, a).rows.filter((r) => r.kind === 'Financing bill').reduce((s, r) => s + r.outstanding, 0));
  add('Sales invoice receivables', bal('1210'), O.openInvoices(d, a).rows.filter((r) => r.kind === 'Sales invoice').reduce((s, r) => s + r.outstanding, 0));
  add('TDS receivable vs active TDS credits', bal('1300'), P((d.prepare("SELECT COALESCE(SUM(amount),0) v FROM tds_credit_entries WHERE status='ACTIVE' AND transaction_date<=?").get(a) as any).v));
  add('TDS payable vs TDS on posted payments', -bal('2200'), P((d.prepare("SELECT COALESCE(SUM(tds_amount),0) v FROM payments WHERE status='POSTED' AND payment_date<=?").get(a) as any).v));
  const ob = O.openBills(d, a);
  const openingAp = P((d.prepare("SELECT COALESCE(SUM(CASE WHEN opening_balance_type='PAYABLE' THEN opening_balance ELSE -opening_balance END),0) v FROM parties").get() as any).v);
  add('Trade payables vs open bills + opening − unapplied payments', -bal('2100'), ob.total + openingAp - ob.unapplied_total);
  add('GST output vs sales invoices', -bal('2300'), P((d.prepare("SELECT COALESCE(SUM(cgst+sgst+igst),0) v FROM sales WHERE status='POSTED' AND invoice_date<=?").get(a) as any).v));
  const funding = P((d.prepare(`SELECT COALESCE(SUM(MAX(0,l.principal_amount-COALESCE((SELECT SUM(o.amount) FROM money_out o WHERE o.loan_id=l.id AND o.out_type='LOAN_REPAYMENT' AND o.status='POSTED'),0))),0) v FROM funding_loans l WHERE l.status='ACTIVE'`).get() as any).v);
  add('Loans (ledger) vs Funding register outstanding principal', -bal('2400'), funding);
  add('Suspense must be zero', bal('1900'), 0);
  add('Trial balance: debits − credits', tb.totals.closing_debit - tb.totals.closing_credit, 0);
  const exceptions = j.exceptions.map((e) => ({ ...e, amount: e.amount ?? null }));
  return { as_of: a, checks, exceptions, passed: checks.every((c) => c.status === 'OK') };
}

export function reportById(id: string) { return REPORTS.find((r) => r.id === id); }
export function catalog() {
  return [...REPORTS.map(({ run, ...meta }) => meta), GROUP_REPORT_META];
}
export function makeCtx(d: any, params: Params, today: string): Ctx {
  let j: Journal | null = null;
  return { d, params, today, journal: () => (j ||= buildJournal(d)) };
}
void isBank;
