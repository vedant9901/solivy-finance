/**
 * Data-health diagnostics and explicit, audited repairs (v2.7.0).
 * Replaces repairs that v2.6.30 performed silently inside GET /api/data and on every
 * database open. Nothing here runs automatically.
 */
type DB = any;

export const LEGACY_TDS_SQL = `SELECT r.id, r.bill_no, r.receivable_amount, r.received_amount, r.tds_amount FROM financing_receivables r WHERE r.status='OPEN' AND r.received_amount>0 AND r.tds_amount>0 AND ABS((r.receivable_amount-r.received_amount)-r.tds_amount)<0.01 AND ABS(COALESCE(r.net_received,0)-r.received_amount)<0.01 AND (SELECT COUNT(*) FROM account_transactions t WHERE t.reference_type='FINANCE_RECEIPT' AND t.reference_id=r.id AND t.transaction_type='CREDIT')=1 AND ABS((SELECT COALESCE(SUM(t.amount),0) FROM account_transactions t WHERE t.reference_type='FINANCE_RECEIPT' AND t.reference_id=r.id AND t.transaction_type='CREDIT')-r.received_amount)<0.01`;

export function diagnose(d: DB) {
  const legacyTds = d.prepare(LEGACY_TDS_SQL).all();
  const moneyInDebits = d.prepare("SELECT id, account_id, transaction_date, amount, reference_no FROM account_transactions WHERE reference_type='MONEY_IN' AND transaction_type='DEBIT'").all();
  const billStats = d.prepare('SELECT COUNT(*) c, COALESCE(MAX(bill_number),0) mx FROM purchases').get() as any;
  const billStart = Number((d.prepare('SELECT purchase_bill_start_after FROM company_settings WHERE id=1').get() as any)?.purchase_bill_start_after || 0);
  const corruptBillNumbers = Number(billStats.c) > 0 && billStart === 0 && Number(billStats.mx) > Math.max(1_000_000, Number(billStats.c) * 1000);
  const unknownReferences = d.prepare(`SELECT reference_type, COUNT(*) n, ROUND(SUM(amount),2) amount FROM account_transactions WHERE COALESCE(reference_type,'') NOT IN ('PAYMENT','FINANCE_RECEIPT','FINANCE_RECEIPT_REVERSED','RECEIPT','MONEY_IN','INTEREST','TRANSFER','WITHDRAWAL','DEPOSIT','REVERSAL','ADMIN_REPAIR','OPENING','MONEY_OUT','INTERCOMPANY_TRANSFER','INTERCOMPANY_RECEIPT') GROUP BY reference_type`).all();
  const allocationOverruns = d.prepare(`SELECT p.id, p.sample_no, p.net_payable, SUM(a.amount) allocated FROM purchases p JOIN payment_allocations a ON a.purchase_id=p.id JOIN payments pay ON pay.id=a.payment_id AND pay.status='POSTED' GROUP BY p.id HAVING SUM(a.amount) > p.net_payable + 0.01`).all();
  const receivableOverruns = d.prepare(`SELECT id, bill_no, receivable_amount, received_amount FROM financing_receivables WHERE received_amount > receivable_amount + 0.01`).all();
  const negativeBalances = d.prepare(`SELECT a.id, a.account_name, a.opening_balance+COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id),0) balance FROM company_accounts a WHERE a.active=1 AND a.opening_balance+COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id),0) < -0.01`).all();
  const issues = [
    legacyTds.length && { code: 'LEGACY_TDS_RECEIVABLE', severity: 'medium', count: legacyTds.length, repair: 'settle_legacy_tds', detail: 'Receivables where an older build stored the net bank amount as received; the remaining balance equals the TDS deducted by the payer.' },
    moneyInDebits.length && { code: 'MONEY_IN_STORED_AS_DEBIT', severity: 'high', count: moneyInDebits.length, repair: 'fix_money_in_direction', detail: 'Money-in receipts stored as DEBIT by an older build reduce the bank balance instead of increasing it.' },
    corruptBillNumbers && { code: 'CORRUPT_BILL_NUMBERS', severity: 'low', count: Number(billStats.c), repair: 'renumber_bills', detail: `Internal purchase bill numbers inherited the AUTOINCREMENT sequence (max ${billStats.mx}).` },
    unknownReferences.length && { code: 'UNCLASSIFIED_CASH_ROWS', severity: 'medium', count: unknownReferences.length, repair: null, detail: 'Bank/cash rows with a reference type the ledger cannot classify; they post to Suspense.' },
    allocationOverruns.length && { code: 'OVER_ALLOCATED_PURCHASES', severity: 'high', count: allocationOverruns.length, repair: null, detail: 'Payment allocations exceed the purchase net payable.' },
    receivableOverruns.length && { code: 'OVER_RECEIVED_RECEIVABLES', severity: 'high', count: receivableOverruns.length, repair: null, detail: 'Received amount exceeds the receivable amount.' },
    negativeBalances.length && { code: 'NEGATIVE_BANK_BALANCE', severity: 'medium', count: negativeBalances.length, repair: null, detail: 'Bank/cash accounts with a negative computed balance.' },
  ].filter(Boolean);
  return { issues, details: { legacyTds, moneyInDebits, unknownReferences, allocationOverruns, receivableOverruns, negativeBalances } };
}

/** Apply one named repair to the given ids (re-verified row by row). Returns affected ids. */
export function repair(d: DB, action: string, ids: number[] | 'all') {
  const pick = (rows: any[]) => rows.filter((r) => ids === 'all' || ids.includes(Number(r.id)));
  if (action === 'settle_legacy_tds') {
    const rows = pick(d.prepare(LEGACY_TDS_SQL).all());
    d.transaction(() => { for (const r of rows) d.prepare("UPDATE financing_receivables SET received_amount=receivable_amount,status='RECEIVED' WHERE id=? AND status='OPEN'").run(r.id); })();
    return rows.map((r: any) => r.id);
  }
  if (action === 'fix_money_in_direction') {
    const rows = pick(d.prepare("SELECT id FROM account_transactions WHERE reference_type='MONEY_IN' AND transaction_type='DEBIT'").all());
    d.transaction(() => { for (const r of rows) d.prepare("UPDATE account_transactions SET transaction_type='CREDIT' WHERE id=? AND reference_type='MONEY_IN' AND transaction_type='DEBIT'").run(r.id); })();
    return rows.map((r: any) => r.id);
  }
  if (action === 'renumber_bills') {
    const diag = diagnose(d);
    if (!diag.issues.some((i: any) => i.code === 'CORRUPT_BILL_NUMBERS')) throw new Error('Bill numbers are not in the corrupt state this repair is designed for.');
    const rows = d.prepare('SELECT id, bill_number FROM purchases ORDER BY id').all() as any[];
    d.transaction(() => { d.prepare('UPDATE purchases SET bill_number=-id').run(); rows.forEach((r, i) => d.prepare('UPDATE purchases SET bill_number=? WHERE id=?').run(i + 1, r.id)); })();
    return rows.map((r) => ({ id: r.id, from: r.bill_number, to: rows.indexOf(r) + 1 }));
  }
  throw new Error(`Unknown repair action: ${action}`);
}

/** Copy master parties/third parties from other organizations assigned to the user (v2.6.30 ?sync_parties=1). */
export function mirrorParties(d: DB, sources: Array<{ id: number; name: string; db: DB }>) {
  let inserted = 0, updated = 0;
  for (const src of sources) {
    const sourceParties = src.db.prepare('SELECT * FROM parties WHERE COALESCE(source_company_id,0)=0 ORDER BY id').all() as any[];
    for (const sp of sourceParties) {
      const found = d.prepare('SELECT * FROM parties WHERE source_company_id=? AND source_party_id=?').get(src.id, Number(sp.id)) as any;
      const incoming = [sp.name, sp.address || '', sp.contact || '', sp.email || '', sp.gst || '', sp.pan || '', sp.party_type || 'GOODS_VENDOR', sp.entity_type || 'OTHER', sp.resident_status || 'RESIDENT', sp.pan_status || 'VALID', Number(sp.tds_enabled || 0), sp.tds_section || '', Number(sp.tds_rate || 0), Number(sp.tds_exempt || 0), String(src.name), Number(sp.active || 0)];
      if (found) {
        const existing = [found.name, found.address || '', found.contact || '', found.email || '', found.gst || '', found.pan || '', found.party_type || 'GOODS_VENDOR', found.entity_type || 'OTHER', found.resident_status || 'RESIDENT', found.pan_status || 'VALID', Number(found.tds_enabled || 0), found.tds_section || '', Number(found.tds_rate || 0), Number(found.tds_exempt || 0), found.source_company_name || '', Number(found.active || 0)];
        if (incoming.some((v, i) => String(v ?? '') !== String(existing[i] ?? ''))) { d.prepare('UPDATE parties SET name=?,address=?,contact=?,email=?,gst=?,pan=?,party_type=?,entity_type=?,resident_status=?,pan_status=?,tds_enabled=?,tds_section=?,tds_rate=?,tds_exempt=?,source_company_name=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(...incoming, Number(found.id)); updated++; }
        continue;
      }
      if (!Number(sp.active || 0)) continue;
      d.prepare("INSERT INTO parties(name,address,contact,email,gst,pan,party_type,entity_type,resident_status,pan_status,tds_enabled,tds_section,tds_rate,tds_exempt,opening_balance,opening_balance_type,source_company_id,source_party_id,source_company_name,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'PAYABLE',?,?,?,?)").run(...incoming.slice(0, 14), src.id, Number(sp.id), String(src.name), Number(sp.active || 0));
      inserted++;
    }
    for (const st of src.db.prepare('SELECT * FROM third_parties WHERE COALESCE(source_company_id,0)=0 ORDER BY id').all() as any[]) {
      const found = d.prepare('SELECT * FROM third_parties WHERE source_company_id=? AND source_third_party_id=?').get(src.id, Number(st.id)) as any;
      if (found) { d.prepare('UPDATE third_parties SET name=?,address=?,contact=?,gst=?,pan=?,email=?,active=?,source_company_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(st.name, st.address || '', st.contact || '', st.gst || '', st.pan || '', st.email || '', Number(st.active || 0), String(src.name), Number(found.id)); updated++; }
      else if (Number(st.active || 0)) { d.prepare('INSERT INTO third_parties(name,address,contact,gst,pan,email,active,source_company_id,source_third_party_id,source_company_name) VALUES(?,?,?,?,?,?,1,?,?,?)').run(st.name, st.address || '', st.contact || '', st.gst || '', st.pan || '', st.email || '', src.id, Number(st.id), String(src.name)); inserted++; }
    }
  }
  return { inserted, updated };
}
