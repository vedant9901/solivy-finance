import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import { NextResponse } from 'next/server';
import { adminDb, db } from '../../../lib/db';
import { n } from '../../../lib/utils';

async function __bridge_POST(req: Request) {
  try {
    const x = await req.json();
    const mode = sessionMode(req);
    const companyId = Number(req.headers.get('x-aksh-company-id') || x.company_id || 1);
    const d = db(mode, companyId);
    const destinationCompanyId = Number(x.destination_company_id || 0);
    const destinationAccountId = Number(x.destination_account_id || 0);
    if (x.destination_company_id && (!Number.isSafeInteger(destinationCompanyId) || destinationCompanyId <= 0)) throw new Error('Select a valid destination organization.');
    if (x.destination_account_id && (!Number.isSafeInteger(destinationAccountId) || destinationAccountId <= 0)) throw new Error('Select a valid destination bank/cash account.');
    let destinationDb: any = null; let destinationCompanyName = '';
    if (destinationCompanyId) {
      if (String(x.out_type || 'REFUND') === 'REFUND') throw new Error('Refunds are party refunds, not inter-company transfers. Choose Other Money Out or Loan Principal Repayment for a company-to-company transfer.');
      if (destinationCompanyId === companyId) throw new Error('Choose a different destination organization.');
      const a = adminDb(), username = String(req.headers.get('x-aksh-user') || ''), role = String(req.headers.get('x-aksh-role') || '');
      const company = a.prepare('SELECT id,name FROM companies WHERE id=? AND active=1').get(destinationCompanyId) as any;
      if (!company) throw new Error('Destination organization is not active.');
      let allowed = role === 'ADMIN';
      if (!allowed) { const user = a.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(username) as any; if (user) allowed = !!a.prepare(`SELECT 1 FROM user_companies WHERE user_id=? AND company_id=? AND ${mode === 'TEST' ? 'can_test=1' : 'can_live=1'}`).get(user.id,destinationCompanyId); }
      if (!allowed) throw new Error('You are not mapped to the destination organization in this environment.');
      destinationDb = db(mode,destinationCompanyId); destinationCompanyName = String(company.name);
      if (!destinationAccountId || !destinationDb.prepare('SELECT id FROM company_accounts WHERE id=? AND active=1').get(destinationAccountId)) throw new Error('Select an active bank/cash account in the destination organization.');
    }
    const type = String(x.out_type || 'REFUND');
    const amount = Math.round(n(x.amount) * 100) / 100;
    const accountId = Number(x.account_id);
    const date = String(x.payment_date || '');
    if (!['REFUND', 'LOAN_REPAYMENT', 'OTHER'].includes(type)) throw new Error('Select a valid money-out purpose.');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid payment date is required.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.');
    const account = d.prepare('SELECT id FROM company_accounts WHERE id=? AND active=1').get(accountId) as any;
    if (!account) throw new Error('Select an active bank/cash account.');
    const partyId = type === 'REFUND' ? Number(x.party_id) : null;
    const loanId = type === 'LOAN_REPAYMENT' ? Number(x.loan_id) : null;
    if (type === 'REFUND') {
      if (!partyId) throw new Error('Select the party whose Money In receipt is being refunded.');
      const party = d.prepare('SELECT id FROM parties WHERE id=? AND active=1').get(partyId);
      if (!party) throw new Error('Selected party was not found or is inactive.');
    }
    if (type === 'LOAN_REPAYMENT' && !loanId) throw new Error('Select a loan to repay.');
    const no = String(x.payment_no || '').trim() || `OUT-${date.replaceAll('-', '')}-${Date.now().toString().slice(-6)}`;
    const result = d.transaction(() => {
      let loan: any = null;
      if (type === 'REFUND') {
        const received = Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_in WHERE party_id=? AND status='POSTED'").get(partyId) as any).total || 0);
        const refunded = Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE party_id=? AND out_type='REFUND' AND status='POSTED'").get(partyId) as any).total || 0);
        const outstanding = Math.max(0, received - refunded);
        if (outstanding <= 0.009) throw new Error('This party has no outstanding Money In amount available for refund.');
        if (amount - outstanding > 0.009) throw new Error(`Refund exceeds this party's outstanding Money In balance of ${outstanding.toFixed(2)}.`);
      }
      if (type === 'LOAN_REPAYMENT') {
        loan = d.prepare('SELECT * FROM funding_loans WHERE id=?').get(loanId) as any;
        if (!loan) throw new Error('Selected loan was not found.');
        if (String(loan.status || 'ACTIVE') !== 'ACTIVE') throw new Error('Only ACTIVE loans can be repaid. Reverse the inter-company loan transfer first if this loan was transferred.');
        const repaid = Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(loanId) as any).total || 0);
        const outstanding = Math.max(0, Number(loan.principal_amount || 0) - repaid);
        if (outstanding <= 0.009) throw new Error('This loan principal is already fully repaid.');
        if (amount - outstanding > 0.009) throw new Error(`Repayment exceeds outstanding loan principal of ${outstanding.toFixed(2)}. Interest must be posted separately in Interest Paid.`);
      }
      const ins = d.prepare(`INSERT INTO money_out(payment_no,payment_date,account_id,amount,out_type,party_id,loan_id,reference_no,narration,destination_company_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(no, date, accountId, amount, type, partyId, loanId, String(x.reference_no || ''), String(x.narration || (type === 'REFUND' ? 'Refund against Money In' : type === 'LOAN_REPAYMENT' ? 'Loan principal repayment' : destinationCompanyId ? `${type === 'LOAN_REPAYMENT' ? 'Inter-company loan principal repayment to' : 'Inter-company transfer to'} ${destinationCompanyName}` : 'Other money out')), destinationCompanyId || null);
      const id = Number(ins.lastInsertRowid);
      d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`)
        .run(accountId, date, 'DEBIT', amount, 'MONEY_OUT', id, no, String(x.narration || (destinationCompanyId ? `${type === 'LOAN_REPAYMENT' ? 'Inter-company loan principal repayment to' : 'Inter-company transfer to'} ${destinationCompanyName} · ${no}` : type.replaceAll('_', ' '))));
      if (type === 'REFUND' && partyId) {
        d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,credit,narration) VALUES(?,?,?,?,?,?,?)`)
          .run(partyId, date, 'REFUND', id, no, amount, String(x.narration || 'Refund against money received'));
      }
      if (type === 'LOAN_REPAYMENT' && loanId) {
        const repaidAfter = Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(loanId) as any).total || 0);
        const balance = Math.max(0, Number(loan.principal_amount || 0) - repaidAfter);
        d.prepare('UPDATE funding_loans SET status=? WHERE id=?').run(balance <= 0.009 ? 'REPAID' : 'ACTIVE', loanId);
      }
      try { d.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user') || 'unknown'), 'CREATE', 'MONEY_OUT', id, JSON.stringify({ paymentNo: no, type, amount, partyId, loanId, accountId, companyId, destinationCompanyId: destinationCompanyId || null, destinationAccountId: destinationAccountId || null, mode })); } catch {}
      return { id, paymentNo: no };
    })();
    if (destinationCompanyId && destinationDb && (type === 'OTHER' || type === 'LOAN_REPAYMENT')) {
      let receiptId = 0;
      try {
        const sourceCompany = adminDb().prepare('SELECT name FROM companies WHERE id=?').get(companyId) as any; const sourceName = String(sourceCompany?.name || `Company ${companyId}`);
        const receiptNo = `ICR-${companyId}-${date.replaceAll('-', '')}-${String(result.id).padStart(5, '0')}`;
        receiptId = destinationDb.transaction(() => {
          const rec = destinationDb.prepare(`INSERT INTO money_in(receipt_no,receipt_date,account_id,amount,receipt_type,party_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(receiptNo,date,destinationAccountId,amount,(type === 'LOAN_REPAYMENT' ? 'INTERCOMPANY_LOAN_REPAYMENT' : 'INTERCOMPANY_RECEIPT'),null,no,`${type === 'LOAN_REPAYMENT' ? 'Inter-company loan principal repayment from' : 'Inter-company receipt from'} ${sourceName} · ${no}`);
          const rid = Number(rec.lastInsertRowid);
          destinationDb.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(destinationAccountId,date,'CREDIT',amount,'MONEY_IN',rid,receiptNo,`${type === 'LOAN_REPAYMENT' ? 'Inter-company loan principal repayment from' : 'Inter-company receipt from'} ${sourceName} · ${no}`);
          try { destinationDb.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'CREATE','INTERCOMPANY_RECEIPT',rid,JSON.stringify({sourceCompanyId:companyId,destinationCompanyId,sourceMoneyOutId:result.id,amount,mode})); } catch {}
          return rid;
        })();
        d.prepare('UPDATE money_out SET destination_receipt_id=? WHERE id=?').run(receiptId,result.id);
        return NextResponse.json({ok:true,...result,intercompany:true,destination_company_id:destinationCompanyId,destination_receipt_id:receiptId,message:`Money Out posted and matching Money In created in ${destinationCompanyName}.`});
      } catch (targetError:any) {
        try { if(receiptId) { const rec=destinationDb.prepare('SELECT * FROM money_in WHERE id=?').get(receiptId) as any; destinationDb.transaction(()=>{destinationDb.prepare("UPDATE money_in SET status='REVERSED' WHERE id=?").run(receiptId);destinationDb.prepare("INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)").run(destinationAccountId,date,'DEBIT',amount,'REVERSAL',receiptId,rec?.receipt_no||'','Compensating reversal after inter-company posting failure')})();} } catch {}
        try { d.transaction(()=>{d.prepare("DELETE FROM account_transactions WHERE UPPER(reference_type)='MONEY_OUT' AND reference_id=?").run(result.id);d.prepare('DELETE FROM money_out WHERE id=?').run(result.id);if(type==='LOAN_REPAYMENT'&&loanId){const loan=d.prepare('SELECT principal_amount FROM funding_loans WHERE id=?').get(loanId) as any;const paid=Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(loanId) as any).total||0);d.prepare('UPDATE funding_loans SET status=? WHERE id=?').run(Number(loan?.principal_amount||0)-paid<=0.009?'REPAID':'ACTIVE',loanId);}})(); } catch {}
        throw targetError;
      }
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not post money out.' }, { status: 400 });
  }
}

export const runtime = 'nodejs';
const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }
