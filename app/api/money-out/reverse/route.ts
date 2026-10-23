import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { sessionMode, adminDb, db } from '../../../../lib/db';
import { NextResponse } from 'next/server';
async function __bridge_POST(req:Request){
 try{
  const x=await req.json(),mode=sessionMode(req),companyId=Number(req.headers.get('x-aksh-company-id')||x.company_id||1),d=db(mode,companyId),id=Number(x.id);
  const r=d.prepare("SELECT * FROM money_out WHERE id=? AND status='POSTED'").get(id) as any;
  if(!r)throw new Error('Posted Money Out entry not found. It may already be reversed.');
  let target:any=null,targetDb:any=null;
  if(Number(r.destination_company_id||0)>0&&Number(r.destination_receipt_id||0)>0){
   const destinationCompanyId=Number(r.destination_company_id),a=adminDb(),who=String(req.headers.get('x-aksh-user')||''),role=String(req.headers.get('x-aksh-role')||'');let allowed=false;
   if(role==='ADMIN')allowed=!!a.prepare('SELECT id FROM companies WHERE id=? AND active=1').get(destinationCompanyId);else{const u=a.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(who) as any;if(u)allowed=!!a.prepare(`SELECT 1 FROM user_companies WHERE user_id=? AND company_id=? AND ${mode==='TEST'?'can_test=1':'can_live=1'}`).get(u.id,destinationCompanyId);}
   if(!allowed)throw new Error('You must be mapped to the destination organization in this environment to reverse this inter-company transaction.');
   targetDb=db(mode,destinationCompanyId);target=targetDb.prepare("SELECT * FROM money_in WHERE id=? AND status='POSTED'").get(Number(r.destination_receipt_id)) as any;
   if(!target)throw new Error('The matching destination Money In entry is missing or already reversed. Reconcile both organizations before continuing.');
  }
  const date=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
  let targetReversed=false;
  try{
   if(target){targetDb.transaction(()=>{targetDb.prepare("UPDATE money_in SET status='REVERSED' WHERE id=? AND status='POSTED'").run(target.id);targetDb.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(target.account_id,date,'DEBIT',''+target.amount,'REVERSAL',target.id,target.receipt_no,'Reversal of inter-company receipt '+target.receipt_no);try{targetDb.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'REVERSE','INTERCOMPANY_RECEIPT',target.id,JSON.stringify({sourceCompanyId:companyId,reason:String(x.reason||''),mode}));}catch{}})();targetReversed=true;}
   d.transaction(()=>{d.prepare("UPDATE money_out SET status='REVERSED' WHERE id=? AND status='POSTED'").run(id);d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(r.account_id,date,'CREDIT',r.amount,'REVERSAL',id,r.payment_no,'Reversal of Money Out '+r.payment_no);if(r.out_type==='REFUND'&&r.party_id)d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,debit,narration) VALUES(?,?,?,?,?,?,?)`).run(r.party_id,date,'REVERSAL',id,r.payment_no,r.amount,String(x.reason||'Money-out refund reversal'));if(r.out_type==='LOAN_REPAYMENT'&&r.loan_id){const loan=d.prepare('SELECT principal_amount FROM funding_loans WHERE id=?').get(r.loan_id) as any;const paid=Number((d.prepare("SELECT COALESCE(SUM(amount),0) total FROM money_out WHERE loan_id=? AND out_type='LOAN_REPAYMENT' AND status='POSTED'").get(r.loan_id) as any).total||0);d.prepare('UPDATE funding_loans SET status=? WHERE id=?').run(Number(loan?.principal_amount||0)-paid<=0.009?'REPAID':'ACTIVE',r.loan_id);}try{d.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'REVERSE','MONEY_OUT',id,JSON.stringify({paymentNo:r.payment_no,reason:String(x.reason||''),companyId,destinationCompanyId:r.destination_company_id||null,mode}));}catch{}})();
  }catch(err){if(targetReversed&&target){try{targetDb.transaction(()=>{targetDb.prepare("UPDATE money_in SET status='POSTED' WHERE id=?").run(target.id);targetDb.prepare("DELETE FROM account_transactions WHERE UPPER(reference_type)='REVERSAL' AND reference_id=? AND narration LIKE 'Reversal of inter-company receipt%'").run(target.id)})();}catch{}}throw err;}
  return NextResponse.json({ok:true,message:target?'Money Out and its matching destination Money In were reversed.':'Money Out entry reversed.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Could not reverse Money Out.'},{status:400})}
}
export const runtime='nodejs';const wrapped=withPostgresSQLiteBridge(__bridge_POST);export async function POST(req:Request){return wrapped(req)}
