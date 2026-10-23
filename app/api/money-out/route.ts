import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import { NextResponse } from 'next/server';
import { db, adminDb } from '../../../lib/db';
import { n } from '../../../lib/utils';

async function __bridge_POST(req: Request) {
  try {
    const x = await req.json();
    const mode = sessionMode(req);
    const companyId = Number(req.headers.get('x-aksh-company-id') || x.company_id || 1);
    const d = db(mode, companyId);
    const type = String(x.out_type || 'REFUND');
    const amount = Math.round(n(x.amount) * 100) / 100;
    const accountId = Number(x.account_id);
    const date = String(x.payment_date || '');
    if (!['REFUND', 'LOAN_REPAYMENT', 'OTHER'].includes(type)) throw new Error('Select a valid money-out purpose.');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid payment date is required.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.');
    const account = d.prepare('SELECT id FROM company_accounts WHERE id=? AND active=1').get(accountId) as any;
    if (!account) throw new Error('Select an active bank/cash account.');
    const destinationCompanyId=Number(x.destination_company_id||0),destinationAccountId=Number(x.destination_account_id||0);
    let destinationDb:any=null,destinationAccount:any=null,destinationCompany:any=null;
    if(destinationCompanyId){
      if(destinationCompanyId===companyId)throw new Error('Choose a different destination organization.');
      if(type==='REFUND')throw new Error('Refunds cannot be routed to another organization. Use Other Money Out or Loan Principal Repayment for an inter-company transfer.');
      if(!['OTHER','LOAN_REPAYMENT'].includes(type))throw new Error('This money-out purpose cannot be routed to another organization.');
      const ad=adminDb(),who=String(req.headers.get('x-aksh-user')||''),role=String(req.headers.get('x-aksh-role')||'');
      if(role==='ADMIN')destinationCompany=ad.prepare('SELECT id,name,code FROM companies WHERE id=? AND active=1').get(destinationCompanyId) as any;
      else {const usr=ad.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(who) as any;if(usr&&ad.prepare(`SELECT 1 FROM user_companies WHERE user_id=? AND company_id=? AND ${mode==='TEST'?'can_test=1':'can_live=1'}`).get(usr.id,destinationCompanyId))destinationCompany=ad.prepare('SELECT id,name,code FROM companies WHERE id=? AND active=1').get(destinationCompanyId) as any;}
      if(!destinationCompany)throw new Error('Destination organization is not mapped to this user in the selected environment.');
      destinationDb=db(mode,destinationCompanyId);destinationAccount=destinationDb.prepare('SELECT id,account_name FROM company_accounts WHERE id=? AND active=1').get(destinationAccountId) as any;
      if(!destinationAccount)throw new Error('Select an active bank/cash account in the destination organization.');
    }
    const partyId = type === 'REFUND' ? Number(x.party_id) : null;
    const loanId = type === 'LOAN_REPAYMENT' ? Number(x.loan_id) : null;
    if (type === 'REFUND') {
      if (!partyId) throw new Error('Select the party whose Money In receipt is being refunded.');
      const party = d.prepare('SELECT id FROM parties WHERE id=? AND active=1').get(partyId);
      if (!party) throw new Error('Selected party was not found or is inactive.');
    }
    if (type === 'LOAN_REPAYMENT' && !loanId) throw new Error('Select a loan to repay.');
    const no = String(x.payment_no || '').trim() || `OUT-${date.replaceAll('-', '')}-${Date.now().toString().slice(-6)}`;
    let result:any;
    result = d.transaction(() => {
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
        const repaid = Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(loanId) as any).total || 0);
        const outstanding = Math.max(0, Number(loan.principal_amount || 0) - repaid);
        if (outstanding <= 0.009) throw new Error('This loan principal is already fully repaid.');
        if (amount - outstanding > 0.009) throw new Error(`Repayment exceeds outstanding loan principal of ${outstanding.toFixed(2)}. Interest must be posted separately in Interest Paid.`);
      }
      const ins = d.prepare(`INSERT INTO money_out(payment_no,payment_date,account_id,amount,out_type,party_id,loan_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(no, date, accountId, amount, type, partyId, loanId, String(x.reference_no || ''), String(x.narration || (type === 'REFUND' ? 'Refund against Money In' : type === 'LOAN_REPAYMENT' ? 'Loan principal repayment' : 'Other money out')));
      const id = Number(ins.lastInsertRowid);
      d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`)
        .run(accountId, date, 'DEBIT', amount, 'MONEY_OUT', id, no, String(x.narration || type.replaceAll('_', ' ')));
      if (type === 'REFUND' && partyId) {
        d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,credit,narration) VALUES(?,?,?,?,?,?,?)`)
          .run(partyId, date, 'REFUND', id, no, amount, String(x.narration || 'Refund against money received'));
      }
      if (type === 'LOAN_REPAYMENT' && loanId) {
        const repaidAfter = Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(loanId) as any).total || 0);
        const balance = Math.max(0, Number(loan.principal_amount || 0) - repaidAfter);
        d.prepare('UPDATE funding_loans SET status=? WHERE id=?').run(balance <= 0.009 ? 'REPAID' : 'ACTIVE', loanId);
      }
      try { d.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user') || 'unknown'), 'CREATE', 'MONEY_OUT', id, JSON.stringify({ paymentNo: no, type, amount, partyId, loanId, accountId, companyId, mode })); } catch {}
      return { id, paymentNo: no };
    })();
      if(destinationCompanyId&&destinationDb&&destinationAccount){
        let dstId:number|undefined; try { const receiptNo=`ICR-${date.replaceAll('-','')}-${String(result.id).padStart(5,'0')}`; const sourceCompanyRow=adminDb().prepare('SELECT name FROM companies WHERE id=?').get(companyId) as {name?:string}|undefined; const sourceName=String(sourceCompanyRow?.name||`Company ${companyId}`); dstId=destinationDb.transaction(()=>{const ins=destinationDb.prepare(`INSERT INTO money_in(receipt_no,receipt_date,account_id,amount,receipt_type,party_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(receiptNo,date,destinationAccountId,amount,'INTERCOMPANY_RECEIPT',null,no,`Inter-company receipt from ${sourceName} · ${no}`);const id=Number(ins.lastInsertRowid);destinationDb.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(destinationAccountId,date,'CREDIT',amount,'MONEY_IN',id,receiptNo,`Inter-company receipt from ${sourceName} · ${no}`);try{destinationDb.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'CREATE','INTERCOMPANY_RECEIPT',id,JSON.stringify({sourceCompanyId:companyId,destinationCompanyId,sourceMoneyOutId:result.id,amount,mode}));}catch{}return id;})(); d.prepare('UPDATE money_out SET destination_company_id=?,destination_receipt_id=? WHERE id=?').run(destinationCompanyId,dstId,result.id);return NextResponse.json({ok:true,...result,intercompany:true,destination_company_id:destinationCompanyId,destination_receipt_id:dstId,message:'Money Out posted and matching Money In created in the destination organization.'}); }
        catch(targetError:any){ if(dstId){try{destinationDb.transaction(()=>{const rec=destinationDb.prepare('SELECT * FROM money_in WHERE id=?').get(dstId) as any;if(rec&&rec.status==='POSTED'){destinationDb.prepare("UPDATE money_in SET status='REVERSED' WHERE id=?").run(dstId);destinationDb.prepare('INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)').run(destinationAccountId,date,'DEBIT',Number(rec.amount||0),'REVERSAL',dstId,rec.receipt_no,'Compensating reversal after inter-company posting failure')}})()}catch{}} try{d.transaction(()=>{d.prepare("DELETE FROM account_transactions WHERE UPPER(reference_type)='MONEY_OUT' AND reference_id=?").run(result.id);d.prepare("DELETE FROM ledger WHERE UPPER(entry_type)='REFUND' AND reference_id=?").run(result.id);d.prepare('DELETE FROM money_out WHERE id=?').run(result.id);if(type==='LOAN_REPAYMENT'&&loanId)d.prepare("UPDATE funding_loans SET status='ACTIVE' WHERE id=?").run(loanId)})();}catch{} throw targetError; }
      }
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not post money out.' }, { status: 400 });
  }
}

async function __bridge_GET(req:Request){try{const u=new URL(req.url),mode=sessionMode(req),companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1),destination=Number(u.searchParams.get('destination_company_id')||0),who=String(req.headers.get('x-aksh-user')||''),role=String(req.headers.get('x-aksh-role')||'');if(!destination||destination===companyId)return NextResponse.json({accounts:[]});const a=adminDb();let allowed=false;if(role==='ADMIN')allowed=!!a.prepare('SELECT id FROM companies WHERE id=? AND active=1').get(destination);else{const user=a.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(who) as any;if(user)allowed=!!a.prepare(`SELECT 1 FROM user_companies WHERE user_id=? AND company_id=? AND ${mode==='TEST'?'can_test=1':'can_live=1'}`).get(user.id,destination);}if(!allowed)return NextResponse.json({error:'Destination organization is not mapped to this user for the selected environment.'},{status:403});const accounts=db(mode,destination).prepare('SELECT id,account_name,bank_name,account_type FROM company_accounts WHERE active=1 ORDER BY account_name').all();return NextResponse.json({accounts});}catch(e:any){return NextResponse.json({error:e?.message||'Could not load destination accounts.'},{status:400})}}

export const runtime = 'nodejs';
const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
