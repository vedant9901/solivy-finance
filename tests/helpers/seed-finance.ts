/**
 * Posts a coherent FY 2026-27 scenario through the REAL API (every rule, validation and posting
 * is the application's own). Used by parity, ledger and report reconciliation tests.
 * All figures below follow from lib/utils.ts purchaseCalc and the route formulas.
 */
import { call, expectOk } from './app';

export async function seedFinance(cookie: string) {
  const post = async (p: string, body: any, method = 'POST') => expectOk(await call(p, { cookie, body, method }), `${method} ${p}`);
  const data = async (modules = '') => expectOk(await call('/api/data', { cookie, query: modules ? { modules } : {} }));

  await post('/api/accounts', { account_name: 'HDFC Current', bank_name: 'HDFC', account_type: 'BANK', opening_balance: 1_000_000, opening_date: '2026-04-01' });
  await post('/api/accounts', { account_name: 'Cash', bank_name: 'Cash', account_type: 'CASH', opening_balance: 50_000, opening_date: '2026-04-01' });
  await post('/api/parties', { name: 'Vendor One', party_type: 'GOODS_VENDOR', opening_balance: 20_000, opening_balance_type: 'PAYABLE', gst: '24AAAAA1111A1Z5' });
  await post('/api/parties', { name: 'Vendor Two', party_type: 'GOODS_VENDOR' });
  await post('/api/parties', { name: 'Customer One', party_type: 'CUSTOMER' });
  await post('/api/parties', { name: 'Lender One', party_type: 'LENDER' });
  let d = await data();
  const acct = (n: string) => d.accounts.find((a: any) => a.account_name === n).id;
  const party = (n: string) => d.parties.find((p: any) => p.name === n).id;
  const A = acct('HDFC Current'), CASH = acct('Cash'), V1 = party('Vendor One'), V2 = party('Vendor Two'), C1 = party('Customer One'), L1 = party('Lender One');

  // Capital and loan received (money in)
  await post('/api/money-in', { receipt_date: '2026-04-01', account_id: A, amount: 200_000, receipt_type: 'CAPITAL', narration: 'Partner capital' });
  await post('/api/money-in', { receipt_date: '2026-04-02', account_id: A, amount: 500_000, receipt_type: 'LOAN_RECEIVED', party_id: L1, narration: 'Term loan disbursed' });
  await post('/api/funding', { lender_name: 'Lender One', lender_party_id: L1, loan_start_date: '2026-04-02', principal_amount: 500_000, interest_type: 'PERCENT', interest_rate: 1, frequency: 'MONTHLY', first_payment_date: '2026-05-02' });

  // Purchases (P1, P2 financed for Customer One; P3 plain with GST input)
  const P1 = (await post('/api/purchases', { party_id: V1, purchase_date: '2026-04-05', net_weight: 10_000, gross_weight: 10_100, rate: 50, freight: 2_000, unload_charge: 500, discount_pct: 1, truck_number: 'GJ01AA1001', goods_description: 'Cumin', receivable_party_id: C1, receivable_due_days: 30, invoice_no: 'V1-INV-1' })).id;
  const P2 = (await post('/api/purchases', { party_id: V2, purchase_date: '2026-04-20', net_weight: 5_000, gross_weight: 5_050, rate: 60, other_charges: 1_000, truck_number: 'GJ01AA1002', goods_description: 'Fennel', receivable_party_id: C1, receivable_due_days: 45, invoice_no: 'V2-INV-1' })).id;
  const P3 = (await post('/api/purchases', { party_id: V1, purchase_date: '2026-05-10', net_weight: 2_000, gross_weight: 2_020, rate: 55, gst_type: 'CGST_SGST', gst_rate: 5, gst_taxable: 110_000, hsn: '0909', truck_number: 'GJ01AA1003', goods_description: 'Coriander', invoice_no: 'V1-INV-2' })).id;

  // Vendor payments (auto-allocation, oldest first) and one reversed payment
  await post('/api/payments', { party_id: V1, payment_date: '2026-04-25', amount: 300_000, mode: 'BANK', company_account_id: A });
  await post('/api/payments', { party_id: V2, payment_date: '2026-05-05', amount: 299_000, mode: 'BANK', company_account_id: A });
  const wrong = await post('/api/payments', { party_id: V2, payment_date: '2026-05-06', amount: 1_000, mode: 'BANK', company_account_id: A });
  await post('/api/reverse', { type: 'PAYMENT', id: wrong.id, reason: 'Duplicate entry' });

  // Financing receivable receipts: P1 full with 0.1% TDS deducted by payer; P2 partial
  d = await data();
  const R1 = d.receivables.find((r: any) => r.purchase_id === P1).id;
  const R2 = d.receivables.find((r: any) => r.purchase_id === P2).id;
  await post('/api/receivables', { id: R1, amount: 497_500, tds_rate: 0.1, account_id: A, received_date: '2026-05-15', tds_section: '194Q' });
  await post('/api/receivables', { id: R2, bank_amount: 150_000, tds_rate: 0, account_id: A, received_date: '2026-05-20' });

  // Interest (scheduled + ad-hoc), loan principal repayment
  d = await data();
  const sched = d.fundingSchedule[0];
  await post('/api/funding/pay', { schedule_id: sched.id, amount: sched.interest_amount, account_id: A, payment_date: sched.due_date, payee: 'Lender One' });
  await post('/api/interest-payments', { payment_date: '2026-05-31', account_id: A, amount: 4_000, payee: 'Bank OD interest' });
  const loan = d.fundingLoans[0];
  await post('/api/money-out', { out_type: 'LOAN_REPAYMENT', loan_id: loan.id, payment_date: '2026-06-01', account_id: A, amount: 100_000, narration: 'Principal repayment' });

  // Bank → cash transfer and a cash withdrawal
  await post('/api/account-movements', { movement_type: 'TRANSFER', movement_date: '2026-05-01', from_account_id: A, to_account_id: CASH, amount: 20_000 });
  await post('/api/account-movements', { movement_type: 'WITHDRAWAL', movement_date: '2026-05-02', from_account_id: CASH, amount: 5_000, narration: 'Office expenses' });

  // GST sales invoice with partial receipt
  const S1 = await post('/api/sales', { invoice_no: 'S-001', invoice_date: '2026-05-12', customer_name: 'Retail Buyer', customer_gstin: '27BBBBB2222B1Z5', taxable_value: 100_000, gst_type: 'CGST_SGST', gst_rate: 5, hsn: '0909', due_days: 15 });
  d = await data();
  const saleId = S1.id || d.sales.find((s: any) => s.invoice_no === 'S-001').id;
  await post('/api/receipts', { sale_id: saleId, amount: 50_000, account_id: A, received_date: '2026-05-25' });

  return { A, CASH, V1, V2, C1, L1, P1, P2, P3, R1, R2, saleId, loanId: loan.id };
}
