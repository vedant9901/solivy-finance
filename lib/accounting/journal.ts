/**
 * Derived double-entry journal (see docs/adr/ADR-001-derived-double-entry-journal.md).
 * Read-only: builds balanced vouchers from existing source records. Amounts in integer paise.
 */
import { toPaise } from '../money';

export type Group = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type CashClass = 'cash' | 'operating' | 'investing' | 'financing';
export type AccountDef = { code: string; name: string; group: Group; review?: boolean; cashflow: CashClass; parent?: string };

export const CHART: Record<string, AccountDef> = Object.fromEntries(([
  ['1100', 'Bank & Cash', 'ASSET', 'cash'],
  ['1200', 'Trade Receivables – Financing', 'ASSET', 'operating'],
  ['1210', 'Trade Receivables – Sales Invoices', 'ASSET', 'operating'],
  ['1300', 'TDS Receivable (deducted by customers)', 'ASSET', 'operating'],
  ['1500', 'Inter-company Receivable', 'ASSET', 'financing'],
  ['1900', 'Suspense (unclassified)', 'ASSET', 'operating', true],
  ['1950', 'Non-bank Settlements Clearing', 'ASSET', 'operating', true],
  ['2100', 'Trade Payables', 'LIABILITY', 'operating'],
  ['2200', 'TDS Payable', 'LIABILITY', 'operating'],
  ['2300', 'GST Output Payable', 'LIABILITY', 'operating'],
  ['2400', 'Loans', 'LIABILITY', 'financing'],
  ['2500', 'Party Advances Received', 'LIABILITY', 'operating', true],
  ['2600', 'Inter-company Payable', 'LIABILITY', 'financing'],
  ['3100', 'Capital', 'EQUITY', 'financing'],
  ['3200', 'Drawings / Withdrawals', 'EQUITY', 'financing', true],
  ['3900', 'Opening Balance Equity', 'EQUITY', 'financing'],
  ['4100', 'Sales – Financing', 'INCOME', 'operating'],
  ['4200', 'Sales – Invoices', 'INCOME', 'operating'],
  ['4300', 'Interest Income', 'INCOME', 'operating'],
  ['4400', 'Other Receipts', 'INCOME', 'operating', true],
  ['4500', 'Refunds Received', 'INCOME', 'operating', true],
  ['5100', 'Purchases', 'EXPENSE', 'operating'],
  ['5200', 'Interest Expense', 'EXPENSE', 'financing'],
  ['5400', 'Other Expenses', 'EXPENSE', 'operating', true],
] as const).map(([code, name, group, cashflow, review]) => [code, { code, name, group, cashflow, review: Boolean(review) } as AccountDef]));

export const MONEY_IN_MAP: Record<string, string> = { CAPITAL: '3100', LOAN_RECEIVED: '2400', PARTY_ADVANCE: '2500', INTEREST_RECEIVED: '4300', REFUND: '4500', OTHER_RECEIPT: '4400', INTERCOMPANY_RECEIPT: '2600', INTERCOMPANY_LOAN_REPAYMENT: '2600' };
export function moneyOutAccount(o: any) {
  if (o.out_type === 'LOAN_REPAYMENT') return '2400';
  if (Number(o.destination_company_id || 0) > 0) return '1500';
  if (o.out_type === 'REFUND') return '2500';
  return '5400';
}

export type Line = { account: string; party: string | null; debit: number; credit: number };
export type Voucher = { id: string; date: string; type: string; ref: string; narration: string; source: string; lines: Line[] };
export type JournalException = { code: string; severity: 'low' | 'medium' | 'high'; message: string; source?: string; amount?: number };
export type Journal = { accounts: Map<string, AccountDef>; vouchers: Voucher[]; exceptions: JournalException[]; partyNames: Map<string, string> };

const bankCode = (id: number) => `1100.${id}`;
export const isBank = (code: string) => code === '1100' || code.startsWith('1100.');
const day = (v: any) => String(v || '').slice(0, 10);

export function buildJournal(d: any): Journal {
  const accounts = new Map<string, AccountDef>(Object.entries(CHART));
  const vouchers: Voucher[] = [];
  const exceptions: JournalException[] = [];
  const partyNames = new Map<string, string>();
  const ex = (code: string, severity: JournalException['severity'], message: string, source?: string, amount?: number) => exceptions.push({ code, severity, message, source, amount });

  function post(date: string, type: string, ref: string, narration: string, source: string, lines: Array<[string, string | null, number, number]>) {
    const ls: Line[] = lines.filter(([, , dr, cr]) => dr !== 0 || cr !== 0).map(([account, party, dr, cr]) => {
      // Normalise negative amounts onto the opposite side.
      const debit = (dr > 0 ? dr : 0) + (cr < 0 ? -cr : 0); const credit = (cr > 0 ? cr : 0) + (dr < 0 ? -dr : 0);
      return { account, party, debit, credit };
    });
    if (!ls.length) return;
    const dr = ls.reduce((s, l) => s + l.debit, 0), cr = ls.reduce((s, l) => s + l.credit, 0);
    if (dr !== cr) {
      ls.push({ account: '1900', party: null, debit: dr < cr ? cr - dr : 0, credit: dr > cr ? dr - cr : 0 });
      ex('UNBALANCED_SOURCE', 'high', `${type} ${ref}: source amounts do not balance; difference posted to Suspense.`, source, Math.abs(dr - cr));
    }
    vouchers.push({ id: `${source}#${vouchers.length}`, date: day(date), type, ref: String(ref || ''), narration: String(narration || ''), source, lines: ls });
  }

  // ---------- load ----------
  const all = (sql: string, ...p: any[]) => d.prepare(sql).all(...p) as any[];
  const banks = all('SELECT id, account_name, account_type, opening_balance, opening_date, active FROM company_accounts');
  for (const b of banks) accounts.set(bankCode(b.id), { code: bankCode(b.id), name: `${b.account_name}${b.active ? '' : ' (inactive)'}`, group: 'ASSET', cashflow: 'cash', parent: '1100' });
  const parties = all('SELECT id, name, opening_balance, opening_balance_type, created_at FROM parties');
  for (const p of parties) partyNames.set(`P${p.id}`, p.name);
  const ledgerRows = all("SELECT id, party_id, entry_date, entry_type, reference_id, reference_no, debit, credit FROM ledger WHERE entry_type IN ('OPENING','REVERSAL')");
  const purchases = all('SELECT * FROM purchases');
  const purchaseById = new Map(purchases.map((p) => [Number(p.id), p]));
  const receivables = all('SELECT * FROM financing_receivables');
  const receivableById = new Map(receivables.map((r) => [Number(r.id), r]));
  const sales = all('SELECT * FROM sales');
  const saleById = new Map(sales.map((s) => [Number(s.id), s]));
  const payments = all('SELECT * FROM payments');
  const paymentById = new Map(payments.map((p) => [Number(p.id), p]));
  const tdsEntries = all('SELECT * FROM tds_credit_entries');
  const tdsBySource = new Map<number, number>();
  for (const t of tdsEntries) if (t.source_transaction_id) tdsBySource.set(Number(t.source_transaction_id), (tdsBySource.get(Number(t.source_transaction_id)) || 0) + toPaise(t.amount));
  const moneyIn = new Map(all('SELECT * FROM money_in').map((m) => [Number(m.id), m]));
  const moneyOut = new Map(all('SELECT * FROM money_out').map((m) => [Number(m.id), m]));
  const interest = new Map(all('SELECT * FROM interest_payments').map((m) => [Number(m.id), m]));
  const cash = all('SELECT * FROM account_transactions ORDER BY transaction_date, id');
  const P = (id: any) => (id ? `P${id}` : null);
  const C = (name: any) => { const k = `C:${String(name || '').trim()}`; partyNames.set(k, String(name || '').trim() || 'Unknown customer'); return k; };

  // ---------- opening balances ----------
  for (const b of banks) {
    const amt = toPaise(b.opening_balance);
    if (amt) post(b.opening_date || '1970-01-01', 'OPENING', b.account_name, 'Opening balance', `company_accounts:${b.id}`, [[bankCode(b.id), null, amt, 0], ['3900', null, 0, amt]]);
  }
  for (const p of parties) {
    const amt = toPaise(p.opening_balance);
    if (!amt) continue;
    const led = ledgerRows.find((l) => l.entry_type === 'OPENING' && Number(l.party_id) === Number(p.id));
    const date = day(led?.entry_date || p.created_at) || '1970-01-01';
    if (p.opening_balance_type === 'RECEIVABLE') post(date, 'OPENING', p.name, 'Party opening receivable', `parties:${p.id}`, [['2100', P(p.id), amt, 0], ['3900', null, 0, amt]]);
    else post(date, 'OPENING', p.name, 'Party opening payable', `parties:${p.id}`, [['3900', null, amt, 0], ['2100', P(p.id), 0, amt]]);
  }

  // ---------- purchases & financing receivables ----------
  const reversalDate = (p: any) => {
    const r = ledgerRows.find((l) => l.entry_type === 'REVERSAL' && Number(l.reference_id) === Number(p.id) && String(l.reference_no || '') === String(p.sample_no || '') && Math.abs(toPaise(l.debit) - toPaise(p.net_payable)) <= 1);
    return r ? day(r.entry_date) : null;
  };
  for (const p of purchases) {
    const status = String(p.status || '').toUpperCase();
    if (status !== 'POSTED' && status !== 'REVERSED') continue;
    const amt = toPaise(p.net_payable);
    const lines: Array<[string, string | null, number, number]> = [['5100', P(p.party_id), amt, 0], ['2100', P(p.party_id), 0, amt]];
    if (status === 'REVERSED') {
      const rd = reversalDate(p);
      if (!rd) { ex('PURCHASE_REVERSAL_UNDATED', 'low', `Reversed purchase ${p.sample_no} has no dated reversal record; treated as void.`, `purchases:${p.id}`, amt); continue; }
      post(p.purchase_date, 'PURCHASE', p.sample_no, `Purchase ${p.goods_description || ''}`.trim(), `purchases:${p.id}`, lines);
      post(rd, 'PURCHASE_REVERSAL', p.sample_no, 'Reversal of purchase', `purchases:${p.id}:reversal`, lines.map(([a, pt, dr, cr]) => [a, pt, cr, dr]));
      continue;
    }
    post(p.purchase_date, 'PURCHASE', p.sample_no, `Purchase ${p.goods_description || ''}`.trim(), `purchases:${p.id}`, lines);
  }
  for (const r of receivables) {
    const status = String(r.status || '').toUpperCase();
    const amt = toPaise(r.receivable_amount);
    const lines: Array<[string, string | null, number, number]> = [['1200', P(r.party_id), amt, 0], ['4100', P(r.party_id), 0, amt]];
    if (status === 'CANCELLED') {
      const pu = purchaseById.get(Number(r.purchase_id));
      const rd = pu ? reversalDate(pu) : null;
      if (toPaise(r.received_amount) > 0) ex('CANCELLED_RECEIVABLE_WITH_RECEIPTS', 'high', `Cancelled receivable ${r.bill_no} still shows receipts.`, `financing_receivables:${r.id}`, toPaise(r.received_amount));
      if (!rd) { ex('RECEIVABLE_CANCELLATION_UNDATED', 'low', `Cancelled receivable ${r.bill_no} has no dated cancellation; treated as void.`, `financing_receivables:${r.id}`, amt); continue; }
      post(r.bill_date, 'FINANCE_BILL', r.bill_no, 'Financing receivable', `financing_receivables:${r.id}`, lines);
      post(rd, 'FINANCE_BILL_CANCEL', r.bill_no, 'Cancellation (purchase reversed)', `financing_receivables:${r.id}:cancel`, lines.map(([a, pt, dr, cr]) => [a, pt, cr, dr]));
      continue;
    }
    post(r.bill_date, 'FINANCE_BILL', r.bill_no, 'Financing receivable', `financing_receivables:${r.id}`, lines);
  }
  for (const s of sales) {
    if (String(s.status || 'POSTED').toUpperCase() !== 'POSTED') continue;
    const total = toPaise(s.total_value), base = toPaise(s.receivable_base || s.taxable_value), tax = toPaise(s.cgst) + toPaise(s.sgst) + toPaise(s.igst);
    post(s.invoice_date, 'SALES_INVOICE', s.invoice_no, `Sales invoice — ${s.customer_name}`, `sales:${s.id}`, [['1210', C(s.customer_name), total, 0], ['4200', C(s.customer_name), 0, base], ['2300', null, 0, tax]]);
  }

  // ---------- bank / cash book ----------
  const consumedPayments = new Set<number>();
  const pairedTransfers = new Map<string, any>();
  const reversedReceiptRows = cash.filter((t) => t.reference_type === 'FINANCE_RECEIPT_REVERSED');
  const usedReversedReceipts = new Set<number>();

  function paymentVoucher(p: any, date: string, cashAcct: string | null, cashAmt: number, source: string, reverse: boolean, ref: string) {
    const gross = toPaise(p.amount), tds = toPaise(p.tds_amount);
    const net = cashAcct ? cashAmt : gross - tds;
    const settle = cashAcct || '1950';
    if (!cashAcct && !reverse) ex('NON_BANK_PAYMENT', 'low', `Payment ${p.payment_no} (mode ${p.mode}) has no bank/cash row; posted to Non-bank Settlements Clearing.`, `payments:${p.id}`, net);
    if (cashAcct && net !== gross - tds) ex('CASH_AMOUNT_MISMATCH', 'medium', `Payment ${p.payment_no}: bank amount differs from gross − TDS.`, source, Math.abs(net - (gross - tds)));
    const lines: Array<[string, string | null, number, number]> = [['2100', P(p.party_id), gross, 0], ['2200', null, 0, tds], [settle, null, 0, net]];
    post(date, reverse ? 'PAYMENT_REVERSAL' : 'PAYMENT', ref, reverse ? `Reversal of payment ${p.payment_no}` : `Payment to vendor`, source, reverse ? lines.map(([a, pt, dr, cr]) => [a, pt, cr, dr]) : lines);
  }
  function moneyInLines(m: any, bank: string, amt: number): Array<[string, string | null, number, number]> {
    const acct = MONEY_IN_MAP[String(m.receipt_type)] || '4400';
    if (!MONEY_IN_MAP[String(m.receipt_type)]) ex('UNKNOWN_RECEIPT_TYPE', 'medium', `Money-in ${m.receipt_no} has receipt type ${m.receipt_type}; posted to Other Receipts.`, `money_in:${m.id}`, amt);
    return [[bank, null, amt, 0], [acct, P(m.party_id), 0, amt]];
  }
  const flip = (ls: Array<[string, string | null, number, number]>) => ls.map(([a, p, dr, cr]) => [a, p, cr, dr] as [string, string | null, number, number]);

  for (const t of cash) {
    const bank = bankCode(Number(t.account_id));
    if (!accounts.has(bank)) accounts.set(bank, { code: bank, name: `Account #${t.account_id} (missing)`, group: 'ASSET', cashflow: 'cash', parent: '1100' });
    const amt = toPaise(t.amount);
    const isCredit = String(t.transaction_type).toUpperCase() === 'CREDIT';
    const ref = String(t.reference_no || '');
    const src = `account_transactions:${t.id}`;
    const type = String(t.reference_type || '');
    const rid = Number(t.reference_id || 0);
    const suspense = (why: string) => { ex('UNCLASSIFIED_CASH_ROW', 'medium', `Bank row ${t.id} (${type || 'no type'}): ${why}. Posted to Suspense.`, src, amt); post(t.transaction_date, 'UNCLASSIFIED', ref, t.narration, src, isCredit ? [[bank, null, amt, 0], ['1900', null, 0, amt]] : [['1900', null, amt, 0], [bank, null, 0, amt]]); };

    if (type === 'PAYMENT') {
      const p = paymentById.get(rid);
      if (!p || isCredit) { suspense('payment not found'); continue; }
      consumedPayments.add(rid);
      paymentVoucher(p, t.transaction_date, bank, amt, src, false, ref || p.payment_no);
    } else if (type === 'FINANCE_RECEIPT' || type === 'FINANCE_RECEIPT_REVERSED') {
      const r = receivableById.get(rid);
      if (!r || !isCredit) { suspense('financing receivable not found'); continue; }
      const tds = tdsBySource.get(Number(t.id)) || 0;
      post(t.transaction_date, 'FINANCE_RECEIPT', ref || r.bill_no, `Receipt against ${r.bill_no}`, src, [[bank, null, amt, 0], ['1300', P(r.party_id), tds, 0], ['1200', P(r.party_id), 0, amt + tds]]);
    } else if (type === 'RECEIPT') {
      const s = saleById.get(rid);
      if (!s || !isCredit) { suspense('sales invoice not found'); continue; }
      post(t.transaction_date, 'SALES_RECEIPT', ref || s.invoice_no, `Receipt against ${s.invoice_no}`, src, [[bank, null, amt, 0], ['1210', C(s.customer_name), 0, amt]]);
    } else if (type === 'MONEY_IN') {
      const m = moneyIn.get(rid);
      if (!m || !isCredit) { suspense('money-in receipt not found'); continue; }
      post(t.transaction_date, 'MONEY_IN', ref || m.receipt_no, m.narration || m.receipt_type, src, moneyInLines(m, bank, amt));
    } else if (type === 'MONEY_OUT') {
      const o = moneyOut.get(rid);
      if (!o || isCredit) { suspense('money-out entry not found'); continue; }
      const acct = moneyOutAccount(o);
      if (acct === '5400' || acct === '2500') ex('REVIEW_CLASSIFICATION', 'low', `Money-out ${o.payment_no} (${o.out_type}) classified to ${CHART[acct].name}; confirm with your accountant.`, `money_out:${o.id}`, amt);
      post(t.transaction_date, 'MONEY_OUT', ref || o.payment_no, o.narration || o.out_type, src, [[acct, P(o.party_id), amt, 0], [bank, null, 0, amt]]);
    } else if (type === 'INTEREST') {
      if (isCredit) { suspense('interest payment recorded as a credit'); continue; }
      post(t.transaction_date, 'INTEREST', ref, t.narration || 'Interest paid', src, [['5200', P(interest.get(rid)?.party_id), amt, 0], [bank, null, 0, amt]]);
    } else if (type === 'TRANSFER') {
      const key = `T${rid}`;
      const other = pairedTransfers.get(key);
      if (!other) { pairedTransfers.set(key, t); continue; }
      pairedTransfers.delete(key);
      const from = isCredit ? other : t, to = isCredit ? t : other;
      if (toPaise(from.amount) !== toPaise(to.amount)) ex('TRANSFER_MISMATCH', 'high', `Transfer ${ref}: debit and credit legs differ.`, src, Math.abs(toPaise(from.amount) - toPaise(to.amount)));
      post(t.transaction_date, 'TRANSFER', ref, t.narration || 'Transfer between accounts', src, [[bankCode(Number(to.account_id)), null, toPaise(to.amount), 0], [bankCode(Number(from.account_id)), null, 0, toPaise(from.amount)]]);
    } else if (type === 'WITHDRAWAL') {
      if (isCredit) { suspense('withdrawal recorded as a credit'); continue; }
      post(t.transaction_date, 'WITHDRAWAL', ref, t.narration || 'Withdrawal', src, [['3200', null, amt, 0], [bank, null, 0, amt]]);
    } else if (type === 'DEPOSIT') {
      ex('REVIEW_CLASSIFICATION', 'low', `Deposit row ${t.id} classified to Other Receipts; confirm with your accountant.`, src, amt);
      post(t.transaction_date, 'DEPOSIT', ref, t.narration || 'Deposit', src, isCredit ? [[bank, null, amt, 0], ['4400', null, 0, amt]] : [['4400', null, amt, 0], [bank, null, 0, amt]]);
    } else if (type === 'ADMIN_REPAIR') {
      ex('ADMIN_BALANCE_REPAIR', 'medium', `Administrative balance repair ${ref} posted against Suspense; classify the underlying transaction.`, src, amt);
      post(t.transaction_date, 'ADMIN_REPAIR', ref, t.narration, src, isCredit ? [[bank, null, amt, 0], ['1900', null, 0, amt]] : [['1900', null, amt, 0], [bank, null, 0, amt]]);
    } else if (type === 'REVERSAL') {
      const n = String(t.narration || '').toLowerCase();
      if (n.startsWith('reversal of payment')) {
        const p = paymentById.get(rid);
        if (!p || !isCredit) { suspense('reversed payment not found'); continue; }
        paymentVoucher(p, t.transaction_date, bank, amt, src, true, ref || p.payment_no);
      } else if (n.startsWith('reversal of finance receipt')) {
        const r = receivableById.get(rid);
        const orig = reversedReceiptRows.find((x) => Number(x.reference_id) === rid && toPaise(x.amount) === amt && !usedReversedReceipts.has(Number(x.id)));
        if (!r || isCredit) { suspense('reversed financing receipt not found'); continue; }
        if (orig) usedReversedReceipts.add(Number(orig.id));
        const tds = orig ? (tdsBySource.get(Number(orig.id)) || 0) : 0;
        post(t.transaction_date, 'FINANCE_RECEIPT_REVERSAL', ref || r.bill_no, `Reversal of receipt ${r.bill_no}`, src, [['1200', P(r.party_id), amt + tds, 0], [bank, null, 0, amt], ['1300', P(r.party_id), 0, tds]]);
      } else if (n.startsWith('reversal of receipt') || n.startsWith('reversal of inter-company receipt') || n.startsWith('compensating reversal')) {
        const m = moneyIn.get(rid);
        if (!m || isCredit) { suspense('reversed money-in receipt not found'); continue; }
        post(t.transaction_date, 'MONEY_IN_REVERSAL', ref || m.receipt_no, t.narration, src, flip(moneyInLines(m, bank, amt)));
      } else if (n.startsWith('reversal of interest')) {
        if (!isCredit) { suspense('interest reversal recorded as a debit'); continue; }
        post(t.transaction_date, 'INTEREST_REVERSAL', ref, t.narration, src, [[bank, null, amt, 0], ['5200', P(interest.get(rid)?.party_id), 0, amt]]);
      } else if (n.startsWith('reversal of money-out') || n.startsWith('reversal of money out')) {
        const o = moneyOut.get(rid);
        if (!o || !isCredit) { suspense('reversed money-out entry not found'); continue; }
        post(t.transaction_date, 'MONEY_OUT_REVERSAL', ref || o.payment_no, t.narration, src, [[bank, null, amt, 0], [moneyOutAccount(o), P(o.party_id), 0, amt]]);
      } else suspense('reversal does not reference a known document');
    } else suspense('unknown reference type');
  }
  for (const [, t] of pairedTransfers) {
    ex('TRANSFER_UNPAIRED', 'high', `Transfer leg ${t.id} has no matching leg.`, `account_transactions:${t.id}`, toPaise(t.amount));
    const bank = bankCode(Number(t.account_id)); const amt = toPaise(t.amount);
    post(t.transaction_date, 'TRANSFER', t.reference_no, t.narration, `account_transactions:${t.id}`, String(t.transaction_type).toUpperCase() === 'CREDIT' ? [[bank, null, amt, 0], ['1900', null, 0, amt]] : [['1900', null, amt, 0], [bank, null, 0, amt]]);
  }
  // Payments with no bank row (non-bank modes).
  for (const p of payments) {
    if (consumedPayments.has(Number(p.id))) continue;
    const status = String(p.status || '').toUpperCase();
    if (status !== 'POSTED' && status !== 'REVERSED') continue;
    if (status === 'REVERSED') {
      const led = ledgerRows.find((l) => l.entry_type === 'REVERSAL' && String(l.reference_no || '') === String(p.payment_no) && Math.abs(toPaise(l.credit) - toPaise(p.amount)) <= 1);
      if (!led) { ex('PAYMENT_REVERSAL_UNDATED', 'low', `Reversed payment ${p.payment_no} has no dated reversal; treated as void.`, `payments:${p.id}`, toPaise(p.amount)); continue; }
      paymentVoucher(p, p.payment_date, null, 0, `payments:${p.id}`, false, p.payment_no);
      paymentVoucher(p, led.entry_date, null, 0, `payments:${p.id}:reversal`, true, p.payment_no);
      continue;
    }
    paymentVoucher(p, p.payment_date, null, 0, `payments:${p.id}`, false, p.payment_no);
  }

  // Party opening balances precede all activity: date them no later than the first entry in the books.
  const first = vouchers.reduce((m, v) => (v.date && v.date < m ? v.date : m), '9999-12-31');
  for (const v of vouchers) if (v.type === 'OPENING' && v.source.startsWith('parties:') && v.date > first) v.date = first;
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { accounts, vouchers, exceptions, partyNames };
}

/** Signed balance convention: debit-positive for ASSET/EXPENSE, credit-positive for LIABILITY/EQUITY/INCOME. */
export function natural(group: Group, debit: number, credit: number) {
  return group === 'ASSET' || group === 'EXPENSE' ? debit - credit : credit - debit;
}
export function groupOf(j: Journal, code: string): Group { return (j.accounts.get(code) || j.accounts.get(code.split('.')[0]))!.group; }
