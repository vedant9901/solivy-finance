/**
 * Operational & statutory-support reports read directly from source registers (v2.7.0).
 * Amounts are returned in paise. Every report states its basis in `notes`.
 */
import { toPaise } from '../money';

type DB = any;
const all = (d: DB, sql: string, ...p: any[]) => d.prepare(sql).all(...p) as any[];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
function addDays(date: string, days: number) { const x = new Date(date + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); }
const dueOf = (date: string, dueDate: string, dueDays: number) => (dueDate && String(dueDate).trim()) ? String(dueDate).slice(0, 10) : (Number(dueDays || 0) > 0 ? addDays(String(date).slice(0, 10), Number(dueDays)) : String(date).slice(0, 10));
const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
function bucketOf(daysPastDue: number) { return daysPastDue <= 0 ? 'current' : daysPastDue <= 30 ? 'd1_30' : daysPastDue <= 60 ? 'd31_60' : daysPastDue <= 90 ? 'd61_90' : 'd90_plus'; }
const inRange = (date: string, from?: string, to?: string) => (!from || date >= from) && (!to || date <= to);
const PAID_SQL = `COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED' AND pay.payment_date<=?),0)`;

// ---------------- receivables & payables ----------------
export function openInvoices(d: DB, asOf: string) {
  const fin = all(d, `SELECT r.id, r.bill_no doc_no, r.bill_date doc_date, r.due_date, r.due_days, r.receivable_amount amount, r.party_id, p.name party, r.status FROM financing_receivables r JOIN parties p ON p.id=r.party_id WHERE r.status IN ('OPEN','RECEIVED') AND r.bill_date<=?`, asOf);
  // Per-bill receipts as of the date: bank credit + linked TDS credit, less matched reversals (same logic as the journal).
  const tds = new Map<number, number>(); for (const t of all(d, 'SELECT source_transaction_id s, amount FROM tds_credit_entries WHERE source_transaction_id IS NOT NULL')) tds.set(Number(t.s), (tds.get(Number(t.s)) || 0) + toPaise(t.amount));
  const rows0 = all(d, "SELECT id, reference_id, reference_type, transaction_type, amount, transaction_date, narration FROM account_transactions WHERE reference_type IN ('FINANCE_RECEIPT','FINANCE_RECEIPT_REVERSED','REVERSAL') ORDER BY transaction_date, id");
  const receivedByBill = new Map<number, number>(); const used = new Set<number>();
  for (const t of rows0) {
    if (String(t.transaction_date).slice(0, 10) > asOf) continue;
    const rid = Number(t.reference_id);
    if (t.reference_type !== 'REVERSAL') { receivedByBill.set(rid, (receivedByBill.get(rid) || 0) + toPaise(t.amount) + (tds.get(Number(t.id)) || 0)); continue; }
    if (!String(t.narration || '').toLowerCase().startsWith('reversal of finance receipt')) continue;
    const orig = rows0.find((x) => x.reference_type === 'FINANCE_RECEIPT_REVERSED' && Number(x.reference_id) === rid && toPaise(x.amount) === toPaise(t.amount) && !used.has(Number(x.id)));
    if (orig) used.add(Number(orig.id));
    receivedByBill.set(rid, (receivedByBill.get(rid) || 0) - toPaise(t.amount) - (orig ? tds.get(Number(orig.id)) || 0 : 0));
  }
  for (const r of fin) r.received = (receivedByBill.get(Number(r.id)) || 0) / 100;
  const sales = all(d, `SELECT s.id, s.invoice_no doc_no, s.invoice_date doc_date, s.due_date, s.due_days, s.total_value amount, s.customer_name party,
      COALESCE((SELECT SUM(t.amount) FROM account_transactions t WHERE t.reference_type='RECEIPT' AND t.reference_id=s.id AND t.transaction_date<=?),0) received
    FROM sales s WHERE s.status='POSTED' AND s.invoice_date<=?`, asOf, asOf);
  const rows = [
    ...fin.map((r) => ({ kind: 'Financing bill', ...r, party_key: `P${r.party_id}` })),
    ...sales.map((s) => ({ kind: 'Sales invoice', ...s, party_key: `C:${s.party}` })),
  ].map((r: any) => {
    const due = dueOf(r.doc_date, r.due_date, r.due_days);
    const outstanding = toPaise(r.amount) - toPaise(r.received);
    return { kind: r.kind, id: r.id, doc_no: r.doc_no, doc_date: String(r.doc_date).slice(0, 10), due_date: due, party: r.party, party_key: r.party_key, amount: toPaise(r.amount), received: toPaise(r.received), outstanding, days_past_due: Math.max(0, daysBetween(due, asOf)) };
  }).filter((r) => r.outstanding !== 0);
  rows.sort((a, b) => b.days_past_due - a.days_past_due || a.doc_date.localeCompare(b.doc_date));
  return { as_of: asOf, rows, total: rows.reduce((s, r) => s + r.outstanding, 0), notes: ['Receipts include TDS deducted by the payer (credited to TDS receivable).', 'Reversed receipts are excluded from the date of reversal.'] };
}

export function openBills(d: DB, asOf: string) {
  const rows = all(d, `SELECT p.id, p.sample_no doc_no, p.invoice_no, p.purchase_date doc_date, p.payment_due_date due_date, p.payment_due_days due_days, p.net_payable amount, x.name party, p.party_id, ${PAID_SQL} paid
    FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.purchase_date<=?`, asOf, asOf)
    .map((r) => { const due = dueOf(r.doc_date, r.due_date, r.due_days); const outstanding = toPaise(r.amount) - toPaise(r.paid); return { id: r.id, doc_no: r.doc_no, invoice_no: r.invoice_no, doc_date: String(r.doc_date).slice(0, 10), due_date: due, party: r.party, party_key: `P${r.party_id}`, amount: toPaise(r.amount), paid: toPaise(r.paid), outstanding, days_past_due: Math.max(0, daysBetween(due, asOf)) }; })
    .filter((r) => r.outstanding !== 0);
  rows.sort((a, b) => b.days_past_due - a.days_past_due || a.doc_date.localeCompare(b.doc_date));
  const unapplied = all(d, `SELECT p.id, p.payment_no, p.payment_date, x.name party, p.amount, COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id=p.id),0) allocated FROM payments p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.payment_date<=?`, asOf)
    .map((p) => ({ ...p, amount: toPaise(p.amount), allocated: toPaise(p.allocated), unapplied: toPaise(p.amount) - toPaise(p.allocated) })).filter((p) => p.unapplied > 0);
  return { as_of: asOf, rows, total: rows.reduce((s, r) => s + r.outstanding, 0), unapplied_payments: unapplied, unapplied_total: unapplied.reduce((s, p) => s + p.unapplied, 0), notes: ['Bill-wise outstanding = net payable − posted payment allocations (v2.6.30 basis).', 'Payments not allocated to bills are listed separately as unapplied (vendor advances).', 'Party opening balances are not bill-wise and appear only in the ledger-based AP total.'] };
}

function aging(rows: Array<{ party: string; party_key: string; outstanding: number; days_past_due: number }>) {
  const byParty = new Map<string, any>();
  const totals: any = Object.fromEntries([...BUCKETS, 'total'].map((b) => [b, 0]));
  for (const r of rows) {
    const p = byParty.get(r.party_key) || { party: r.party, party_key: r.party_key, ...Object.fromEntries([...BUCKETS, 'total'].map((b) => [b, 0])) };
    const b = bucketOf(r.days_past_due);
    p[b] += r.outstanding; p.total += r.outstanding; totals[b] += r.outstanding; totals.total += r.outstanding;
    byParty.set(r.party_key, p);
  }
  return { parties: [...byParty.values()].sort((a, b) => b.total - a.total), totals, buckets: ['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'] };
}
export function arAging(d: DB, asOf: string) { const o = openInvoices(d, asOf); return { as_of: asOf, ...aging(o.rows), notes: ['Days past due from the recorded due date (or document date when no due terms).', ...o.notes] }; }
export function apAging(d: DB, asOf: string) { const o = openBills(d, asOf); return { as_of: asOf, ...aging(o.rows), unapplied_total: o.unapplied_total, notes: o.notes }; }

export function unattributedReceipts(d: DB, p: { from?: string; to?: string }) {
  const receipts = all(d, `SELECT m.id, m.receipt_no, m.receipt_date, m.receipt_type, m.amount, m.narration, x.name party FROM money_in m LEFT JOIN parties x ON x.id=m.party_id WHERE m.status='POSTED' AND m.receipt_type IN ('PARTY_ADVANCE','OTHER_RECEIPT','REFUND')`)
    .filter((r) => inRange(String(r.receipt_date).slice(0, 10), p.from, p.to)).map((r) => ({ ...r, amount: toPaise(r.amount), party: r.party || '(no party)' }));
  return { rows: receipts, total: receipts.reduce((s, r) => s + r.amount, 0), notes: ['Money received that is not linked to a financing bill or sales invoice (advances, other receipts, refunds).', 'Match these to customer documents or reclassify them before closing the period.'] };
}

// ---------------- vendors / customers ----------------
export function vendorActivity(d: DB, p: { from: string; to: string }) {
  const vendors = all(d, `SELECT x.id, x.name, x.pan, x.gst, x.opening_balance, x.opening_balance_type,
    COALESCE((SELECT SUM(net_payable) FROM purchases WHERE party_id=x.id AND status='POSTED' AND purchase_date<?),0) purch_before,
    COALESCE((SELECT SUM(amount) FROM payments WHERE party_id=x.id AND status='POSTED' AND payment_date<?),0) paid_before,
    COALESCE((SELECT SUM(net_payable) FROM purchases WHERE party_id=x.id AND status='POSTED' AND purchase_date BETWEEN ? AND ?),0) purchases,
    COALESCE((SELECT COUNT(*) FROM purchases WHERE party_id=x.id AND status='POSTED' AND purchase_date BETWEEN ? AND ?),0) bills,
    COALESCE((SELECT SUM(amount) FROM payments WHERE party_id=x.id AND status='POSTED' AND payment_date BETWEEN ? AND ?),0) payments,
    COALESCE((SELECT SUM(tds_amount) FROM payments WHERE party_id=x.id AND status='POSTED' AND payment_date BETWEEN ? AND ?),0) tds
    FROM parties x`, p.from, p.from, p.from, p.to, p.from, p.to, p.from, p.to, p.from, p.to)
    .map((v) => { const op = toPaise(v.opening_balance) * (v.opening_balance_type === 'RECEIVABLE' ? -1 : 1) + toPaise(v.purch_before) - toPaise(v.paid_before); const closing = op + toPaise(v.purchases) - toPaise(v.payments); return { id: v.id, name: v.name, pan: v.pan, gst: v.gst, opening: op, bills: v.bills, purchases: toPaise(v.purchases), payments: toPaise(v.payments), tds: toPaise(v.tds), closing }; })
    .filter((v) => v.opening || v.purchases || v.payments || v.closing);
  return { from: p.from, to: p.to, rows: vendors.sort((a, b) => b.purchases - a.purchases), notes: ['Payments are gross (TDS included); payable basis matches the general ledger.'] };
}

function quarterOf(date: string) { const m = Number(date.slice(5, 7)); const fyStart = m >= 4 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1; const q = m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 && m <= 12 ? 'Q3' : 'Q4'; return `FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')} ${q}`; }
export function tdsSummary(d: DB, p: { from: string; to: string }) {
  const deducted = all(d, `SELECT p.payment_no, p.payment_date, p.amount, p.tds_base, p.tds_rate, p.tds_amount, p.tds_rule, x.name party, x.pan, x.party_type FROM payments p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.tds_amount>0 AND p.payment_date BETWEEN ? AND ? ORDER BY p.payment_date`, p.from, p.to)
    .map((r) => ({ ...r, quarter: quarterOf(String(r.payment_date)), amount: toPaise(r.amount), tds_base: toPaise(r.tds_base), tds_amount: toPaise(r.tds_amount) }));
  const byQuarter: Record<string, number> = {}; for (const r of deducted) byQuarter[r.quarter] = (byQuarter[r.quarter] || 0) + r.tds_amount;
  const credits = all(d, `SELECT c.transaction_date, c.amount, c.section, c.certificate_reference, r.bill_no, x.name party, x.pan FROM tds_credit_entries c JOIN financing_receivables r ON r.id=c.receivable_id JOIN parties x ON x.id=r.party_id WHERE c.status='ACTIVE' AND c.transaction_date BETWEEN ? AND ? ORDER BY c.transaction_date`, p.from, p.to)
    .map((r) => ({ ...r, quarter: quarterOf(String(r.transaction_date)), amount: toPaise(r.amount) }));
  return { from: p.from, to: p.to, deducted, deducted_total: deducted.reduce((s, r) => s + r.tds_amount, 0), deducted_by_quarter: byQuarter, credits_receivable: credits, credits_total: credits.reduce((s, r) => s + r.amount, 0),
    notes: ['Management summary of TDS recorded in SOLIVY — NOT a TDS return. Verify challans, sections and PAN status on TRACES before filing.', 'Sections/rules are those decided at posting time (lib/tds.ts; Income-tax Act, 1961 before 1 Apr 2026, Income-tax Act, 2025 from 1 Apr 2026). Items marked for review require CA confirmation.', 'TDS credits receivable are amounts customers deducted from you; reconcile with Form 26AS/AIS.'] };
}

export function salesByCustomer(d: DB, p: { from: string; to: string }) {
  const fin = all(d, `SELECT x.id, x.name, COUNT(*) docs, SUM(r.receivable_amount) sales, SUM(r.cost_amount) cost FROM financing_receivables r JOIN parties x ON x.id=r.party_id WHERE r.status IN ('OPEN','RECEIVED') AND r.bill_date BETWEEN ? AND ? GROUP BY x.id`, p.from, p.to)
    .map((r) => ({ customer: r.name, key: `P${r.id}`, source: 'Financing', docs: r.docs, sales: toPaise(r.sales), cost: toPaise(r.cost), tax: 0 }));
  const inv = all(d, `SELECT customer_name, COUNT(*) docs, SUM(receivable_base) sales, SUM(cost_amount) cost, SUM(cgst+sgst+igst) tax FROM sales WHERE status='POSTED' AND invoice_date BETWEEN ? AND ? GROUP BY customer_name`, p.from, p.to)
    .map((r) => ({ customer: r.customer_name, key: `C:${r.customer_name}`, source: 'Sales invoices', docs: r.docs, sales: toPaise(r.sales), cost: toPaise(r.cost), tax: toPaise(r.tax) }));
  const rows = [...fin, ...inv].map((r) => ({ ...r, gross_profit: r.sales - r.cost, margin_pct: r.sales ? Math.round((r.sales - r.cost) / r.sales * 10000) / 100 : 0 })).sort((a, b) => b.sales - a.sales);
  return { from: p.from, to: p.to, rows, total_sales: rows.reduce((s, r) => s + r.sales, 0), total_cost: rows.reduce((s, r) => s + r.cost, 0), notes: ['Financing sales = receivable amount; cost = vendor net payable.', 'Sales-invoice cost is the cost entered on the invoice (0 when not recorded).'] };
}

export function customerDetail(d: DB, partyKey: string, p: { from?: string; to?: string }) {
  if (partyKey.startsWith('C:')) {
    const name = partyKey.slice(2);
    const docs = all(d, `SELECT id, invoice_no doc_no, invoice_date doc_date, total_value amount, received_amount received, status FROM sales WHERE customer_name=? ORDER BY invoice_date`, name).filter((r) => inRange(String(r.doc_date), p.from, p.to));
    const receipts = all(d, `SELECT t.transaction_date date, t.amount, t.reference_no ref FROM account_transactions t JOIN sales s ON s.id=t.reference_id WHERE t.reference_type='RECEIPT' AND s.customer_name=? ORDER BY t.transaction_date`, name);
    return { customer: name, documents: docs.map((r) => ({ ...r, amount: toPaise(r.amount), received: toPaise(r.received) })), receipts: receipts.map((r) => ({ ...r, amount: toPaise(r.amount) })) };
  }
  const id = Number(partyKey.replace(/^P/, ''));
  const party = d.prepare('SELECT id, name, address, contact, email, gst, pan FROM parties WHERE id=?').get(id);
  const docs = all(d, `SELECT r.id, r.bill_no doc_no, r.bill_date doc_date, r.receivable_amount amount, r.received_amount received, r.tds_amount tds, r.status, pu.goods_description item FROM financing_receivables r JOIN purchases pu ON pu.id=r.purchase_id WHERE r.party_id=? ORDER BY r.bill_date`, id).filter((r) => inRange(String(r.doc_date), p.from, p.to));
  const receipts = all(d, `SELECT t.transaction_date date, t.amount, t.reference_type type, t.reference_no ref FROM account_transactions t JOIN financing_receivables r ON r.id=t.reference_id WHERE t.reference_type IN ('FINANCE_RECEIPT','FINANCE_RECEIPT_REVERSED') AND r.party_id=? ORDER BY t.transaction_date`, id);
  return { customer: (party as any)?.name, party, documents: docs.map((r) => ({ ...r, amount: toPaise(r.amount), received: toPaise(r.received), tds: toPaise(r.tds) })), receipts: receipts.map((r) => ({ ...r, amount: toPaise(r.amount) })) };
}

export function salesByItem(d: DB, p: { from: string; to: string }) {
  const fin = all(d, `SELECT COALESCE(NULLIF(TRIM(pu.goods_description),''),'(unspecified)') item, COALESCE(pu.hsn,'') hsn, COUNT(*) docs, SUM(pu.net_weight) qty, SUM(r.receivable_amount) sales, SUM(r.cost_amount) cost FROM financing_receivables r JOIN purchases pu ON pu.id=r.purchase_id WHERE r.status IN ('OPEN','RECEIVED') AND r.bill_date BETWEEN ? AND ? GROUP BY item, hsn`, p.from, p.to).map((r) => ({ ...r, source: 'Financing', unit: 'KG' }));
  const inv = all(d, `SELECT COALESCE(NULLIF(TRIM(description),''),'(unspecified)') item, COALESCE(hsn,'') hsn, COUNT(*) docs, NULL qty, SUM(receivable_base) sales, SUM(cost_amount) cost FROM sales WHERE status='POSTED' AND invoice_date BETWEEN ? AND ? GROUP BY item, hsn`, p.from, p.to).map((r) => ({ ...r, source: 'Sales invoices', unit: '' }));
  const rows = [...fin, ...inv].map((r) => ({ ...r, sales: toPaise(r.sales), cost: toPaise(r.cost), gross_profit: toPaise(r.sales) - toPaise(r.cost) })).sort((a, b) => b.sales - a.sales);
  return { from: p.from, to: p.to, rows, notes: ['Financing items come from the linked purchase (goods description, HSN, net weight in KG).'] };
}

export function salesByRepresentative(d: DB, p: { from: string; to: string }) {
  const rows = all(d, `SELECT COALESCE(b.name,'(no broker recorded)') representative, COUNT(*) docs, SUM(r.receivable_amount) sales, SUM(r.cost_amount) cost FROM financing_receivables r JOIN purchases pu ON pu.id=r.purchase_id LEFT JOIN parties b ON b.id=pu.broker_party_id WHERE r.status IN ('OPEN','RECEIVED') AND r.bill_date BETWEEN ? AND ? GROUP BY representative`, p.from, p.to)
    .map((r) => ({ ...r, sales: toPaise(r.sales), cost: toPaise(r.cost), gross_profit: toPaise(r.sales) - toPaise(r.cost) })).sort((a, b) => b.sales - a.sales);
  return { from: p.from, to: p.to, rows, notes: ['SOLIVY has no sales-representative field. This report groups financing sales by the BROKER party recorded on the purchase. Sales invoices are not included because they carry no broker.'] };
}

export function purchasesByVendor(d: DB, p: { from: string; to: string }) {
  const rows = all(d, `SELECT x.id, x.name vendor, x.gst, COUNT(*) bills, SUM(p.net_weight) qty, SUM(p.gross_amount) gross, SUM(p.total_deduction) deductions, SUM(p.net_payable) net, SUM(p.gst_amount) gst_amount FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.purchase_date BETWEEN ? AND ? GROUP BY x.id`, p.from, p.to)
    .map((r) => ({ ...r, gross: toPaise(r.gross), deductions: toPaise(r.deductions), net: toPaise(r.net), gst_amount: toPaise(r.gst_amount) })).sort((a, b) => b.net - a.net);
  return { from: p.from, to: p.to, rows, total_net: rows.reduce((s, r) => s + r.net, 0), notes: ['Net = gross − deductions (freight, unloading, moisture, discount, quality, other) per the purchase calculation.'] };
}

export function purchasesByItem(d: DB, p: { from: string; to: string }) {
  const rows = all(d, `SELECT COALESCE(NULLIF(TRIM(goods_description),''),'(unspecified)') item, COALESCE(hsn,'') hsn, COUNT(*) bills, SUM(net_weight) qty, SUM(gross_amount) gross, SUM(net_payable) net, SUM(gross_amount)/NULLIF(SUM(net_weight),0) avg_rate FROM purchases WHERE status='POSTED' AND purchase_date BETWEEN ? AND ? GROUP BY item, hsn`, p.from, p.to)
    .map((r) => ({ ...r, gross: toPaise(r.gross), net: toPaise(r.net), avg_rate: Math.round(Number(r.avg_rate || 0) * 100) / 100, unit: 'KG' })).sort((a, b) => b.net - a.net);
  return { from: p.from, to: p.to, rows, notes: ['Average rate = gross amount ÷ net weight (KG).'] };
}

/** Same conversion as app/api/saudas qtyKg(): allocations are stored in KG. */
function kgPerUnit(u: any) { const unit = String(u || 'KG').toUpperCase(); return unit === 'MT' || unit === 'TONNE' ? 1000 : unit === 'QUINTAL' ? 100 : 1; }
export function openPurchaseOrders(d: DB, asOf: string) {
  const rows = all(d, `SELECT s.id, s.sauda_no, s.sauda_date, s.commodity, s.quantity, s.unit, s.purchase_rate, s.sale_rate, s.delivery_date, s.status, COALESCE(pp.name, s.purchase_entity_name, '') supplier, COALESCE(sp.name, s.selling_entity_name, '') buyer,
      COALESCE((SELECT SUM(a.quantity) FROM sauda_allocations a WHERE a.sauda_id=s.id),0) allocated
    FROM saudas s LEFT JOIN parties pp ON pp.id=s.purchase_party_id LEFT JOIN parties sp ON sp.id=s.selling_party_id WHERE s.status NOT IN ('CANCELLED','COMPLETED') AND s.sauda_date<=? ORDER BY s.sauda_date`, asOf)
    .map((r) => { const factor = kgPerUnit(r.unit); const allocatedInUnit = Number(r.allocated || 0) / factor; const open = Math.round((Number(r.quantity || 0) - allocatedInUnit) * 1000) / 1000; return { ...r, allocated: Math.round(allocatedInUnit * 1000) / 1000, open_quantity: open, open_value: toPaise(open * Number(r.purchase_rate || 0)) }; }).filter((r) => r.open_quantity > 0);
  return { as_of: asOf, rows, total_value: rows.reduce((s, r) => s + r.open_value, 0), notes: ['SOLIVY records purchase commitments as Sauda bookings; open = booked quantity not yet allocated to a purchase/stock lot.', 'Allocations are recorded in KG and converted to the Sauda unit (MT ×1000, Quintal ×100).', 'Value = open quantity × booked purchase rate (per Sauda unit).'] };
}

// ---------------- inventory ----------------
export function stockStatus(d: DB) {
  const rows = all(d, `SELECT COALESCE(g.name,'(no godown)') godown, COALESCE(NULLIF(TRIM(i.commodity),''),'(unspecified)') commodity, i.unit, SUM(i.qty_in) qty_in, SUM(i.qty_out) qty_out, SUM(i.qty_in-i.qty_out) balance, COUNT(*) lots FROM inventory_lots i LEFT JOIN godowns g ON g.id=i.godown_id GROUP BY godown, commodity, i.unit ORDER BY godown, commodity`);
  return { rows, notes: ['Quantities from godown inventory lots (in = purchase receipts, out = Sauda allocations).'] };
}
export function inventoryValuation(d: DB) {
  const lots = all(d, `SELECT i.id, i.batch_no, COALESCE(g.name,'(no godown)') godown, i.commodity, i.unit, i.qty_in, i.qty_out, (i.qty_in-i.qty_out) remaining, p.sample_no, p.purchase_date, p.rate, p.net_payable, p.net_weight FROM inventory_lots i LEFT JOIN godowns g ON g.id=i.godown_id LEFT JOIN purchases p ON p.id=i.purchase_id WHERE (i.qty_in-i.qty_out) > 0 ORDER BY p.purchase_date, i.id`)
    .map((l) => { const unitCostGross = Number(l.rate || 0); const unitCostNet = Number(l.net_weight || 0) ? Number(l.net_payable || 0) / Number(l.net_weight) : 0; return { ...l, unit_cost_gross: unitCostGross, unit_cost_net: Math.round(unitCostNet * 10000) / 10000, value_at_rate: toPaise(Number(l.remaining) * unitCostGross), value_at_net_cost: toPaise(Number(l.remaining) * unitCostNet) }; });
  return { rows: lots, total_at_rate: lots.reduce((s, l) => s + l.value_at_rate, 0), total_at_net_cost: lots.reduce((s, l) => s + l.value_at_net_cost, 0), notes: ['Specific identification by lot: each lot is valued at its own purchase.', '“At rate” = remaining quantity × purchase rate; “At net cost” = remaining × (net payable ÷ net weight), i.e. after purchase deductions.', 'Not a lower-of-cost-or-net-realisable-value valuation; NRV review is required for statutory accounts.'] };
}

// ---------------- GST ----------------
export function gstOutward(d: DB, p: { from: string; to: string }) {
  const invoices = all(d, `SELECT invoice_no, invoice_date, customer_name, customer_gstin, place_of_supply, invoice_type, hsn, receivable_base taxable, gst_rate, cgst, sgst, igst, total_value FROM sales WHERE status='POSTED' AND invoice_date BETWEEN ? AND ? ORDER BY invoice_date`, p.from, p.to)
    .map((r) => ({ ...r, taxable: toPaise(r.taxable), cgst: toPaise(r.cgst), sgst: toPaise(r.sgst), igst: toPaise(r.igst), total_value: toPaise(r.total_value), section: r.customer_gstin ? 'B2B' : 'B2C' }));
  const hsn = new Map<string, any>(); const rate = new Map<string, any>();
  for (const r of invoices) {
    for (const [m, k] of [[hsn, `${r.hsn || '(blank)'}`], [rate, `${r.gst_rate}%·${r.section}`]] as const) { const x = m.get(k) || { key: k, count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 }; x.count++; x.taxable += r.taxable; x.cgst += r.cgst; x.sgst += r.sgst; x.igst += r.igst; x.total += r.total_value; m.set(k, x); }
  }
  const t = invoices.reduce((a, r) => ({ taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
  return { from: p.from, to: p.to, invoices, by_hsn: [...hsn.values()], by_rate: [...rate.values()], totals: t, notes: ['Outward supplies from SOLIVY sales invoices (GSTR-1 style summary). Financing bills are not GST invoices in SOLIVY and are excluded.', 'Filing assistance only — validate with the GST portal / your GST practitioner before filing.'] };
}
export function gstInward(d: DB, p: { from: string; to: string }) {
  const rows = all(d, `SELECT p.sample_no, p.invoice_no, p.purchase_date, x.name vendor, x.gst vendor_gstin, p.hsn, p.gst_type, p.gst_rate, p.gst_taxable, p.gst_amount FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.gst_amount>0 AND p.purchase_date BETWEEN ? AND ? ORDER BY p.purchase_date`, p.from, p.to)
    .map((r) => { const amt = toPaise(r.gst_amount); const intra = r.gst_type === 'CGST_SGST'; return { ...r, gst_taxable: toPaise(r.gst_taxable), gst_amount: amt, cgst: intra ? Math.floor(amt / 2) : 0, sgst: intra ? amt - Math.floor(amt / 2) : 0, igst: intra ? 0 : amt, missing_gstin: !String(r.vendor_gstin || '').trim() }; });
  const t = rows.reduce((a, r) => ({ taxable: a.taxable + r.gst_taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
  return { from: p.from, to: p.to, rows, totals: t, notes: ['Input tax recorded on purchases. Eligibility depends on GSTR-2B matching, vendor filing and Section 16 conditions — SOLIVY does not verify these.', 'Rows without a vendor GSTIN are flagged; ITC is normally not available without a valid GSTIN.'] };
}
export function gstSummary(d: DB, p: { from: string; to: string }) {
  const out = gstOutward(d, p).totals, inp = gstInward(d, p);
  const eligible = inp.rows.filter((r) => !r.missing_gstin).reduce((a, r) => ({ cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst }), { cgst: 0, sgst: 0, igst: 0 });
  return { from: p.from, to: p.to, output: out, input_recorded: inp.totals, input_with_gstin: eligible, net_payable_estimate: { cgst: out.cgst - eligible.cgst, sgst: out.sgst - eligible.sgst, igst: out.igst - eligible.igst },
    notes: ['GSTR-3B style ESTIMATE before cross-utilisation rules and GSTR-2B reconciliation. Not a return.', 'Negative values indicate input exceeding output for that head (carry forward / cross-utilisation per GST rules).'] };
}

// ---------------- lists, audit, budgets, forecast ----------------
export function contactList(d: DB, kind: 'customer' | 'vendor') {
  const vendorTypes = ['GOODS_VENDOR', 'CONTRACTOR', 'COMMISSION', 'PROFESSIONAL', 'RENT', 'INTEREST', 'BROKER', 'TRANSPORTER', 'SERVICE_VENDOR'];
  const parties = all(d, `SELECT id, name, party_type, address, contact, email, gst, pan, active, COALESCE(source_company_name,'') mapped_from,
     (SELECT COUNT(*) FROM financing_receivables r WHERE r.party_id=parties.id) receivables, (SELECT COUNT(*) FROM purchases p WHERE p.party_id=parties.id) purchases FROM parties ORDER BY name`);
  const rows = kind === 'vendor' ? parties.filter((p) => vendorTypes.includes(String(p.party_type)) || p.purchases > 0) : parties.filter((p) => ['CUSTOMER', 'BUYER'].includes(String(p.party_type)) || p.receivables > 0);
  if (kind === 'customer') for (const s of all(d, `SELECT customer_name name, MAX(customer_gstin) gst, COUNT(*) invoices FROM sales GROUP BY customer_name`)) if (!rows.some((r) => r.name === s.name)) rows.push({ id: null, name: s.name, party_type: 'SALES_CUSTOMER', gst: s.gst, invoices: s.invoices, active: 1 });
  return { kind, rows };
}
export function auditLog(d: DB, p: { from?: string; to?: string; user?: string; entity?: string; limit?: number; offset?: number }) {
  const where: string[] = []; const args: any[] = [];
  if (p.from) { where.push('created_at >= ?'); args.push(p.from); }
  if (p.to) { where.push("created_at < date(?, '+1 day')"); args.push(p.to); }
  if (p.user) { where.push('username = ?'); args.push(p.user); }
  if (p.entity) { where.push('entity LIKE ?'); args.push(`%${p.entity}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (d.prepare(`SELECT COUNT(*) c FROM audit_logs ${w}`).get(...args) as any).c;
  const rows = all(d, `SELECT id, created_at, username, action, entity, entity_id, details FROM audit_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, Math.min(500, p.limit || 100), p.offset || 0);
  return { total, rows };
}

export function cashForecast(d: DB, asOf: string, cashNow: number, weeks = 13) {
  const inv = openInvoices(d, asOf).rows, bills = openBills(d, asOf).rows;
  const interest = all(d, `SELECT s.due_date, s.interest_amount-s.paid_amount due FROM funding_schedule s JOIN funding_loans l ON l.id=s.loan_id WHERE s.status IN ('DUE','PARTIAL') AND l.status='ACTIVE'`);
  const buckets = Array.from({ length: weeks }, (_, i) => ({ week: i + 1, from: addDays(asOf, i * 7 + (i ? 1 : 0)), to: addDays(asOf, (i + 1) * 7), inflow: 0, outflow: 0, net: 0, closing: 0 }));
  const place = (date: string) => { const idx = date <= buckets[0].to ? 0 : buckets.findIndex((b) => date >= b.from && date <= b.to); return idx; };
  let overdueIn = 0, overdueOut = 0, beyondIn = 0, beyondOut = 0;
  for (const r of inv) { if (r.due_date < asOf) { overdueIn += r.outstanding; continue; } const i = place(r.due_date); if (i < 0) beyondIn += r.outstanding; else buckets[i].inflow += r.outstanding; }
  for (const b of bills) { if (b.due_date < asOf) { overdueOut += b.outstanding; continue; } const i = place(b.due_date); if (i < 0) beyondOut += b.outstanding; else buckets[i].outflow += b.outstanding; }
  for (const s of interest) { const amt = toPaise(s.due); const dd = String(s.due_date).slice(0, 10); if (dd < asOf) { overdueOut += amt; continue; } const i = place(dd); if (i < 0) beyondOut += amt; else buckets[i].outflow += amt; }
  let run = cashNow;
  for (const b of buckets) { b.net = b.inflow - b.outflow; run += b.net; b.closing = run; }
  return { as_of: asOf, opening_cash: cashNow, weeks: buckets, overdue_inflows: overdueIn, overdue_outflows: overdueOut, beyond_horizon_inflows: beyondIn, beyond_horizon_outflows: beyondOut,
    notes: ['ESTIMATE from recorded due dates: open financing bills, sales invoices, vendor bills and scheduled loan interest.', 'Overdue items are shown separately and not assumed to be collected/paid in any week.', 'Excludes loan principal, expenses and receipts not yet recorded.'] };
}
