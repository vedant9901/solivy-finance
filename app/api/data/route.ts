import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { db, adminDb, sessionMode } from '../../../lib/db';
import { companyWatermark, adminWatermark, etagFor, notModified, NOT_MODIFIED_HEADERS } from '../../../lib/data-version';
import { effectiveDiscountRule } from '../../../lib/utils';
export const dynamic = 'force-dynamic';

/**
 * GET /api/data — READ-ONLY (v2.7.0).
 *
 * ?modules=a,b,c returns only those modules (computed only if requested AND permitted).
 * Without ?modules the full v2.6.30 response is returned for backward compatibility.
 * SQL is unchanged from v2.6.30 so every number matches the previous release.
 *
 * v2.7.1: the response carries a strong ETag over the data watermarks, the requested modules and
 * the caller's permissions. A client that sends If-None-Match and is already current gets 304 with
 * no body — switching back to an already loaded screen costs about 1 KB instead of the full module
 * payload — and any change to any table the modules read produces a different ETag.
 *
 * Removed from this GET (they wrote data on a read):
 *  - legacy TDS receivable "repair"  → GET/POST /api/admin/data-health (dry-run + audited apply)
 *  - cross-organization party mirror (?sync_parties=1) → POST /api/admin/data-health {action:'mirror_parties'}
 */
const MODULES = ['core', 'parties', 'purchases', 'payments', 'ledger', 'receivables', 'accounts', 'account-history', 'money', 'funding', 'dashboard', 'legacy'] as const;
type Module = typeof MODULES[number];
void MODULES;

function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function addDays(date: string, days: number) { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function weekEnd(date: string) { const d = new Date(date + 'T00:00:00'); const day = d.getDay(); const delta = day === 0 ? 0 : 7 - day; d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); }
const PAID = `COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED'),0)`;

async function __bridge_GET(req: Request) {
  try {
    const u = new URL(req.url); const mode = sessionMode(req);
    const companyId = Number(req.headers.get('x-aksh-company-id') || 1);
    const d = db(mode, companyId); const t = today(); const tomorrow = addDays(t, 1); const week = weekEnd(t);
    const isAdmin = req.headers.get('x-aksh-role') === 'ADMIN';
    const currentUser = String(req.headers.get('x-aksh-user') || '');
    let menu: string[] = []; try { menu = JSON.parse(req.headers.get('x-aksh-menu') || '[]'); } catch {}
    const can = (id: string) => isAdmin || menu.includes(id);
    const canUseParties = ['sauda', 'parties', 'purchase', 'payments', 'receivables', 'money-in', 'money-out', 'interest', 'funding'].some(can);

    const requested = (u.searchParams.get('modules') || '').split(',').map((x) => x.trim()).filter(Boolean) as Module[];
    const legacy = requested.length === 0 || requested.includes('legacy');

    // Conditional response: identical inputs + unchanged data => 304 with no body.
    const etag = etagFor(['data-v1', companyWatermark(d), adminWatermark(adminDb()), mode, companyId, currentUser, isAdmin ? 'admin' : menu.slice().sort().join('+'), requested.slice().sort().join(','), legacy ? 'legacy' : '', t]);
    if (notModified(req, etag)) return new NextResponse(null, { status: 304, headers: NOT_MODIFIED_HEADERS(etag) });
    const want = (m: Module) => legacy || requested.includes(m);
    const out: any = { meta: { modules: legacy ? ['legacy'] : requested, generated_at: new Date().toISOString(), read_only: true } };

    // Parties mapped from other organizations the user is explicitly assigned to (visibility only; no writes).
    let allowedSourceIds: number[] = [];
    if (want('parties') || want('purchases') || want('payments')) {
      const partyAccess = adminDb();
      const pu = partyAccess.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(currentUser) as any;
      if (canUseParties && pu) allowedSourceIds = (partyAccess.prepare(`SELECT c.id FROM companies c JOIN user_companies uc ON uc.company_id=c.id WHERE uc.user_id=? AND c.active=1 AND c.id<>? AND ${mode === 'TEST' ? 'uc.can_test=1' : 'uc.can_live=1'}`).all(pu.id, companyId) as any[]).map((x) => Number(x.id));
    }
    const allowedSql = allowedSourceIds.length ? ` OR source_company_id IN (${allowedSourceIds.map(() => '?').join(',')})` : '';

    if (want('core')) {
      const ad = adminDb();
      const rawSettings = d.prepare('SELECT * FROM company_settings WHERE id=1').get() as any;
      let documentSettings: any = {}; try { documentSettings = { commercial_bill_settings: JSON.parse(rawSettings?.commercial_bill_settings || '{}'), payment_advice_settings: JSON.parse(rawSettings?.payment_advice_settings || '{}') }; } catch {}
      out.users = isAdmin ? ad.prepare(`SELECT id,username,name,role,active,CASE WHEN lower(username)='admin' OR id=(SELECT id FROM admin_users WHERE role='ADMIN' ORDER BY id LIMIT 1) THEN 1 ELSE 0 END is_primary FROM admin_users ORDER BY username`).all() : [];
      out.companies = isAdmin ? ad.prepare('SELECT id,name,code,email,active FROM companies WHERE active=1 ORDER BY name').all() : ad.prepare('SELECT c.id,c.name,c.code,c.email,c.active,uc.can_live,uc.can_test FROM companies c JOIN user_companies uc ON uc.company_id=c.id JOIN admin_users u ON u.id=uc.user_id WHERE u.username=? AND u.active=1 AND c.active=1 ORDER BY c.name').all(currentUser);
      out.settings = can('settings') || can('document-settings') ? { ...(rawSettings || {}), ...documentSettings } : {};
      const stats = d.prepare(`SELECT (SELECT COUNT(*) FROM parties WHERE active=1) parties,(SELECT COALESCE(SUM(net_payable),0) FROM purchases WHERE status='POSTED') purchases,(SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='POSTED') payments`).get() as any;
      stats.opening = (d.prepare("SELECT COALESCE(SUM(CASE WHEN opening_balance_type='PAYABLE' THEN opening_balance ELSE -opening_balance END),0) v FROM parties").get() as any).v;
      const allocatedPayments = (d.prepare("SELECT COALESCE(SUM(a.amount),0) v FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.status='POSTED'").get() as any).v;
      stats.outstanding = stats.opening + stats.purchases - allocatedPayments;
      out.stats = stats;
    }

    if (want('parties')) {
      const thirdParties = d.prepare(`SELECT * FROM third_parties WHERE active=1 AND (COALESCE(source_company_id,0)=0${allowedSql}) ORDER BY name`).all(...allowedSourceIds);
      const parties = d.prepare(`SELECT p.*,m.bank_name,m.account_holder,m.account_number,m.ifsc,m.branch,COALESCE(p.source_company_name,'') mapped_company_name FROM parties p LEFT JOIN bank_accounts m ON m.id=(SELECT id FROM bank_accounts WHERE party_id=p.id ORDER BY is_primary DESC,id LIMIT 1) WHERE (COALESCE(p.source_company_id,0)=0${allowedSql.replaceAll('source_company_id', 'p.source_company_id')}) ORDER BY p.name`).all(...allowedSourceIds);
      const limitedParties = parties.map((p: any) => ({ id: p.id, name: p.name, active: p.active, party_type: p.party_type, entity_type: p.entity_type, mapped_company_name: p.mapped_company_name, gst: p.gst, pan: p.pan, contact: p.contact }));
      out.thirdParties = can('parties') ? thirdParties : (can('sauda') ? thirdParties.map((p: any) => ({ id: p.id, name: p.name, active: p.active })) : []);
      out.parties = can('parties') ? parties : (canUseParties ? limitedParties : []);
      out.outstanding = can('parties') ? d.prepare(`SELECT x.id,x.name,COALESCE((SELECT SUM(net_payable) FROM purchases p WHERE p.party_id=x.id AND p.status='POSTED'),0) purchases,COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE pay.party_id=x.id AND pay.status='POSTED'),0) payments,COALESCE(x.opening_balance,0)*(CASE WHEN x.opening_balance_type='PAYABLE' THEN 1 ELSE -1 END)+COALESCE((SELECT SUM(net_payable) FROM purchases p WHERE p.party_id=x.id AND p.status='POSTED'),0)-COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE pay.party_id=x.id AND pay.status='POSTED'),0) outstanding FROM parties x ORDER BY outstanding DESC`).all() : [];
    }

    if (want('purchases') && can('purchase')) {
      const purchases = d.prepare(`SELECT p.*,x.name party_name,x.email party_email,x.contact party_contact,bp.name broker_party_name,bp.contact broker_contact,bp.email broker_email, r.party_id receivable_party_id, rp.name receivable_party_name, r.receivable_amount, r.due_days receivable_due_days, r.due_date receivable_due_date, r.notes receivable_notes, ${PAID} paid_amount, p.net_payable-${PAID} outstanding FROM purchases p JOIN parties x ON x.id=p.party_id LEFT JOIN parties bp ON bp.id=p.broker_party_id LEFT JOIN financing_receivables r ON r.purchase_id=p.id LEFT JOIN parties rp ON rp.id=r.party_id ORDER BY p.purchase_date DESC,p.id DESC`).all();
      // v2.8.0: the register and the purchase form must show the same Net Payable. The stored
      // net_payable stays authoritative (it is what the ledger posted); each row also reports the
      // discount base it was saved with, so the form computes with that rule instead of today's
      // company setting, and rows whose stored total cannot be reproduced are flagged rather than
      // quietly disagreeing. No stored figure is changed here.
      const companyRule = Number((d.prepare('SELECT discount_after_quality FROM company_settings WHERE id=1').get() as any)?.discount_after_quality ?? 1);
      const withRule = (p: any) => { const r = effectiveDiscountRule(p, companyRule); return { ...p, discount_rule_used: r.rule, net_payable_calc: r.calculated, net_payable_matches: r.reproduces }; };
      // The legacy (no ?modules=) response keeps the exact v2.6.30 shape; the derived fields are
      // only added for module-based callers (tests/integration/data-parity.test.ts holds this).
      const shaped = legacy ? purchases : purchases.map(withRule);
      out.purchases = can('parties') ? shaped : shaped.map((p: any) => ({ ...p, party_email: '', party_contact: '', broker_contact: '', broker_email: '' }));
    } else if (want('purchases')) out.purchases = [];

    if (want('payments') && can('payments')) {
      const payments = d.prepare('SELECT p.*,x.name party_name,x.email,x.contact,a.account_name company_account_name,(SELECT COALESCE(SUM(amount),0) FROM payment_allocations a2 WHERE a2.payment_id=p.id) allocated FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN company_accounts a ON a.id=p.company_account_id ORDER BY p.payment_date DESC,p.id DESC').all() as any[];
      const allocRows = d.prepare(`SELECT a.payment_id,a.purchase_id,a.amount,q.sample_no,q.invoice_no,q.purchase_date,q.goods_description,q.bags_qty,q.gross_weight,q.net_weight,q.rate,q.gross_amount,q.unload_charge,q.freight,q.moisture,q.discount_amount,q.driver_rokdi,q.quality_deduct_amount,q.other_charges,q.net_payable,q.payment_due_date FROM payment_allocations a JOIN purchases q ON q.id=a.purchase_id JOIN payments pay ON pay.id=a.payment_id WHERE pay.status='POSTED' ORDER BY q.purchase_date,q.id`).all() as any[];
      const map: any = {}; for (const a of allocRows) (map[a.payment_id] ||= []).push(a);
      for (const p of payments) p.allocations = map[p.id] || [];
      out.payments = can('parties') ? payments : payments.map((p: any) => ({ ...p, email: '', contact: '' }));
    } else if (want('payments')) out.payments = [];

    if (want('ledger')) out.ledger = can('ledger') ? d.prepare(`SELECT l.*,p.name party_name,p.email party_email,p.contact party_contact FROM ledger l JOIN parties p ON p.id=l.party_id ORDER BY l.entry_date DESC,l.id DESC`).all() : [];

    if (want('receivables')) {
      const ok = can('receivables');
      out.sales = ok ? d.prepare('SELECT * FROM sales ORDER BY invoice_date DESC,id DESC').all() : [];
      out.receivables = ok ? d.prepare(`SELECT r.*,p.name party_name,pu.sample_no,pu.invoice_no supplier_invoice_no,pu.status purchase_status FROM financing_receivables r JOIN parties p ON p.id=r.party_id JOIN purchases pu ON pu.id=r.purchase_id ORDER BY r.bill_date DESC,r.id DESC`).all() : [];
      out.overdueReceivables = ok ? d.prepare(`SELECT r.id,r.bill_no,r.bill_date,r.party_id,p.name party_name,pu.sample_no,pu.invoice_no supplier_invoice_no,CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END due_date,r.receivable_amount-COALESCE(r.received_amount,0) outstanding,CAST(julianday(?) - julianday(CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END) AS INTEGER) days_overdue FROM financing_receivables r JOIN parties p ON p.id=r.party_id JOIN purchases pu ON pu.id=r.purchase_id WHERE r.status='OPEN' AND (CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END) < ? AND r.receivable_amount>COALESCE(r.received_amount,0) ORDER BY days_overdue DESC,r.id`).all(t, t) : [];
    }

    if (want('accounts') || want('dashboard') || want('receivables')) {
      const profit = d.prepare("SELECT COALESCE(SUM(CASE WHEN received_amount>0 THEN ((discount_amount+other_charges_profit) * received_amount / CASE WHEN receivable_amount=0 THEN 1 ELSE receivable_amount END) ELSE 0 END),0) gross_profit,COALESCE(SUM(CASE WHEN received_amount>0 THEN cost_amount * received_amount / CASE WHEN receivable_amount=0 THEN 1 ELSE receivable_amount END ELSE 0 END),0) cost,COALESCE(SUM(CASE WHEN received_amount>0 THEN received_amount ELSE 0 END),0) sales FROM financing_receivables").get() as any;
      const interestPaid = (d.prepare("SELECT COALESCE(SUM(amount),0) v FROM interest_payments WHERE status='POSTED'").get() as any).v;
      profit.interest_paid = interestPaid; profit.profit = profit.gross_profit - interestPaid; profit.margin = profit.sales ? profit.profit / profit.sales * 100 : 0;
      if (want('dashboard') || want('receivables')) out.profit = can('dashboard') ? profit : {};
    }

    if (want('accounts')) out.accounts = (can('accounts') || can('money-out')) ? d.prepare(`SELECT a.*,a.opening_balance+COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id),0) balance FROM company_accounts a WHERE a.active=1 ORDER BY a.account_name`).all() : [];
    if (want('account-history')) {
      out.accountMovements = can('account-movements') ? d.prepare(`SELECT m.*,fa.account_name from_account_name,ta.account_name to_account_name FROM account_movements m JOIN company_accounts fa ON fa.id=m.from_account_id LEFT JOIN company_accounts ta ON ta.id=m.to_account_id ORDER BY m.movement_date DESC,m.id DESC`).all() : [];
      out.accountTransactions = can('accounts') ? d.prepare(`SELECT t.*,a.account_name,a.account_type FROM account_transactions t JOIN company_accounts a ON a.id=t.account_id ORDER BY t.transaction_date DESC,t.id DESC`).all() : [];
    }

    if (want('money')) {
      out.moneyIn = (can('money-in') || can('money-out')) ? d.prepare(`SELECT m.*,p.name party_name,a.account_name FROM money_in m LEFT JOIN parties p ON p.id=m.party_id JOIN company_accounts a ON a.id=m.account_id ORDER BY m.receipt_date DESC,m.id DESC`).all() : [];
      const moneyOut = (can('money-in') || can('funding') || can('money-out')) ? d.prepare(`SELECT o.*,p.name party_name,l.loan_no,l.lender_name,a.account_name FROM money_out o LEFT JOIN parties p ON p.id=o.party_id LEFT JOIN funding_loans l ON l.id=o.loan_id JOIN company_accounts a ON a.id=o.account_id ORDER BY o.payment_date DESC,o.id DESC`).all() as any[] : [];
      if (moneyOut.some((o) => Number(o.destination_company_id || 0) > 0)) {
        const ad = adminDb();
        for (const o of moneyOut) if (Number(o.destination_company_id || 0) > 0) { const target = ad.prepare('SELECT name FROM companies WHERE id=?').get(Number(o.destination_company_id)) as any; o.destination_company_name = target?.name || `Organization ${o.destination_company_id}`; if (!o.narration) o.narration = `Inter-company transfer to ${o.destination_company_name}`; }
      }
      out.moneyOut = moneyOut;
      out.interestPayments = can('interest') ? d.prepare(`SELECT i.*,p.name party_name,a.account_name FROM interest_payments i LEFT JOIN parties p ON p.id=i.party_id JOIN company_accounts a ON a.id=i.account_id ORDER BY i.payment_date DESC,i.id DESC`).all() : [];
    }

    if (want('funding')) {
      out.fundingLoans = (can('funding') || can('money-out')) ? d.prepare(`SELECT l.*,p.name lender_party_name,CASE WHEN l.status='ACTIVE' THEN MAX(0,l.principal_amount-COALESCE((SELECT SUM(o.amount) FROM money_out o WHERE o.loan_id=l.id AND o.out_type='LOAN_REPAYMENT' AND o.status='POSTED'),0)) ELSE 0 END outstanding_principal,(SELECT MIN(s.due_date) FROM funding_schedule s WHERE s.loan_id=l.id AND s.status IN ('DUE','PARTIAL') AND l.status='ACTIVE') next_due_date,(SELECT COALESCE(SUM(s.interest_amount-s.paid_amount),0) FROM funding_schedule s WHERE s.loan_id=l.id AND s.status IN ('DUE','PARTIAL') AND l.status='ACTIVE') outstanding_interest FROM funding_loans l LEFT JOIN parties p ON p.id=l.lender_party_id ORDER BY l.id DESC`).all() : [];
      out.fundingSchedule = can('funding') ? d.prepare(`SELECT s.*,l.loan_no,l.lender_name FROM funding_schedule s JOIN funding_loans l ON l.id=s.loan_id WHERE s.status IN ('DUE','PARTIAL') AND l.status='ACTIVE' ORDER BY s.due_date,s.id`).all() : [];
    }

    if (legacy) {
      // Fields kept only for API backward compatibility (not used by the v2.7 UI).
      const pendingPurchaseBills = d.prepare(`SELECT p.id,p.purchase_date,p.party_id,x.name party_name,p.invoice_no,p.sample_no,p.net_payable,${PAID} paid_amount,p.net_payable-${PAID} outstanding FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.net_payable>${PAID} ORDER BY p.purchase_date,p.id`).all();
      const unmatched = d.prepare(`SELECT p.*,x.name party_name FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN bank_matches b ON b.payment_id=p.id WHERE b.id IS NULL AND p.status='POSTED' ORDER BY p.id DESC`).all();
      const duePayables = d.prepare(`SELECT p.id,p.sample_no,p.invoice_no,p.purchase_date,CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END payment_due_date,p.net_payable,x.name party_name,${PAID} paid,p.net_payable-${PAID} due_amount FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.payment_due_days>0 AND (CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END) BETWEEN ? AND ? AND p.net_payable>${PAID} ORDER BY payment_due_date,p.id`).all(t, week) as any[];
      const dueReceivables = d.prepare(`SELECT r.*,p.name party_name,pu.sample_no,pu.invoice_no supplier_invoice_no,CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END due_date,r.receivable_amount-COALESCE(r.received_amount,0) outstanding FROM financing_receivables r JOIN parties p ON p.id=r.party_id JOIN purchases pu ON pu.id=r.purchase_id WHERE r.status='OPEN' AND r.due_days>0 AND (CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END) BETWEEN ? AND ? ORDER BY due_date,r.id`).all(t, week) as any[];
      const overduePayables = d.prepare(`SELECT p.id,p.sample_no,p.invoice_no,p.purchase_date,x.name party_name,CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END payment_due_date,p.net_payable,${PAID} paid,p.net_payable-${PAID} due_amount,CAST(julianday(?) - julianday(CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END) AS INTEGER) days_overdue FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.net_payable>${PAID} AND (CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END) < ? ORDER BY days_overdue DESC,p.id`).all(t, t);
      const monthlyProfit = d.prepare(`SELECT substr(r.bill_date,1,7) label,ROUND(SUM(CASE WHEN r.received_amount>0 THEN ((r.discount_amount+r.other_charges_profit)*r.received_amount/CASE WHEN r.receivable_amount=0 THEN 1 ELSE r.receivable_amount END) ELSE 0 END)-COALESCE((SELECT SUM(i.amount) FROM interest_payments i WHERE substr(i.payment_date,1,7)=substr(r.bill_date,1,7) AND i.status='POSTED'),0),0) value FROM financing_receivables r GROUP BY substr(r.bill_date,1,7) ORDER BY label`).all() as any[];
      const monthlyCashIn = d.prepare(`SELECT substr(t.transaction_date,1,7) label,ROUND(SUM(CASE WHEN t.transaction_type='CREDIT' THEN t.amount ELSE 0 END)) value FROM account_transactions t GROUP BY substr(t.transaction_date,1,7) ORDER BY label`).all();
      const fundingUpcoming = d.prepare(`SELECT substr(due_date,1,7) label,ROUND(SUM(interest_amount-paid_amount)) value FROM funding_schedule WHERE status IN ('DUE','PARTIAL') GROUP BY substr(due_date,1,7) ORDER BY label LIMIT 12`).all();
      const fundingSchedule: any[] = out.fundingSchedule || [];
      const averageMonthlyProfit = monthlyProfit.length ? Math.round(monthlyProfit.reduce((a: number, x: any) => a + Number(x.value || 0), 0) / monthlyProfit.length) : 0;
      Object.assign(out, {
        pendingPurchaseBills: can('purchase') ? pendingPurchaseBills : [], unmatched: can('bank') ? unmatched : [],
        duePayables: can('purchase') ? duePayables : [], dueReceivables: can('receivables') ? dueReceivables : [], overduePayables: can('purchase') ? overduePayables : [],
        todayPayable: can('purchase') ? duePayables.filter((x: any) => x.payment_due_date === t) : [], tomorrowPayable: can('purchase') ? duePayables.filter((x: any) => x.payment_due_date === tomorrow) : [],
        todayReceivable: can('receivables') ? dueReceivables.filter((x: any) => x.due_date === t) : [], tomorrowReceivable: can('receivables') ? dueReceivables.filter((x: any) => x.due_date === tomorrow) : [],
        fundingToday: can('funding') ? fundingSchedule.filter((x: any) => x.due_date === t) : [], fundingTomorrow: can('funding') ? fundingSchedule.filter((x: any) => x.due_date === tomorrow) : [],
        nextFunding: can('funding') ? (fundingSchedule[0] || null) : [], averageMonthlyProfit: can('dashboard') ? averageMonthlyProfit : [],
        monthlyProfit: can('dashboard') ? monthlyProfit : [], monthlyCashIn: can('dashboard') ? monthlyCashIn : [], fundingUpcoming: can('funding') ? fundingUpcoming : [],
      });
    }
    return NextResponse.json(out, { headers: NOT_MODIFIED_HEADERS(etag) });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}

export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
