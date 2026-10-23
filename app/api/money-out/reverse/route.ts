import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../../lib/db';
import { NextResponse } from 'next/server';
import { adminDb, db } from '../../../../lib/db';
async function __bridge_POST(req:Request){
 try{
  const x=await req.json();const mode=sessionMode(req);const companyId=Number(req.headers.get('x-aksh-company-id')||x.company_id||1);const d=db(mode,companyId);const id=Number(x.id);
  const r=d.prepare("SELECT * FROM money_out WHERE id=? AND status='POSTED'").get(id) as any;
  if(!r)throw new Error('Posted Money Out entry not found. It may already be reversed.');
  if(r.out_type==='LOAN_REPAYMENT'&&r.loan_id){const linkedLoan=d.prepare('SELECT status FROM funding_loans WHERE id=?').get(r.loan_id) as any;if(linkedLoan&&String(linkedLoan.status)==='TRANSFERRED')throw new Error('This repayment belongs to a transferred loan. Reverse the loan transfer first, then reverse the repayment.');}
  if(r.out_type==='LOAN_REPAYMENT'&&r.loan_id){const linkedLoan=d.prepare('SELECT status FROM funding_loans WHERE id=?').get(r.loan_id) as any;if(linkedLoan&&String(linkedLoan.status)==='TRANSFERRED')throw new Error('This repayment belongs to a transferred loan. Reverse the loan transfer first, then reverse the repayment.');}
  if (Number(r.destination_company_id||0)>0 && Number(r.destination_receipt_id||0)>0) {
    const destinationId=Number(r.destination_company_id),destinationReceiptId=Number(r.destination_receipt_id);const a=adminDb(),username=String(req.headers.get('x-aksh-user')||''),role=String(req.headers.get('x-aksh-role')||'');let allowed=role==='ADMIN';if(!allowed){const user=a.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(username) as any;if(user)allowed=!!a.prepare(`SELECT 1 FROM user_companies WHERE user_id=? AND company_id=? AND ${mode==='TEST'?'can_test=1':'can_live=1'}`).get(user.id,destinationId);}if(!allowed)throw new Error('You must be mapped to the destination organization to reverse this inter-company transfer.');const target=db(mode,destinationId);
    const receipt=target.prepare("SELECT * FROM money_in WHERE id=? AND status='POSTED'").get(destinationReceiptId) as any;
    if(receipt){target.transaction(()=>{target.prepare("UPDATE money_in SET status='REVERSED' WHERE id=? AND status='POSTED'").run(destinationReceiptId);target.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(receipt.account_id,new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10),'DEBIT',receipt.amount,'REVERSAL',destinationReceiptId,receipt.receipt_no,'Reversal of inter-company receipt for '+r.payment_no);try{target.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'REVERSE','INTERCOMPANY_RECEIPT',destinationReceiptId,JSON.stringify({sourceCompanyId:companyId,destinationCompanyId:destinationId,sourceMoneyOutId:id,reason:String(x.reason||''),mode}));}catch{}})();}
  }
  d.transaction(()=>{
   d.prepare("UPDATE money_out SET status='REVERSED' WHERE id=? AND status='POSTED'").run(id);
   d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(r.account_id,new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10),'CREDIT',r.amount,'REVERSAL',id,r.payment_no,'Reversal of Money Out '+r.payment_no);
   if(r.out_type==='REFUND'&&r.party_id)d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,debit,narration) VALUES(?,?,?,?,?,?,?)`).run(r.party_id,new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10),'REVERSAL',id,r.payment_no,r.amount,String(x.reason||'Money-out refund reversal'));
   if(r.out_type==='LOAN_REPAYMENT'&&r.loan_id){const loan=d.prepare('SELECT principal_amount FROM funding_loans WHERE id=?').get(r.loan_id) as any;const paid=Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(r.loan_id) as any).total||0);d.prepare('UPDATE funding_loans SET status=? WHERE id=?').run(Number(loan?.principal_amount||0)-paid<=0.009?'REPAID':'ACTIVE',r.loan_id);}
   try{d.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'REVERSE','MONEY_OUT',id,JSON.stringify({paymentNo:r.payment_no,reason:String(x.reason||''),companyId,mode}));}catch{}
  })();return NextResponse.json({ok:true,message:'Money Out entry reversed.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Could not reverse Money Out.'},{status:400})}
}
export const runtime = 'nodejs';
const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req:Request){return __wrapped_POST(req)}
