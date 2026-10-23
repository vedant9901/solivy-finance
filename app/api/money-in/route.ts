import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import { NextResponse } from 'next/server';
import { db, adminDb } from '../../../lib/db';
import { n } from '../../../lib/utils';
export const runtime='nodejs'; export const dynamic='force-dynamic';
async function __bridge_POST(req:Request){
 try{
  const x=await req.json(),mode=sessionMode(req),companyId=Number(req.headers.get('x-aksh-company-id')||x.company_id||1),d=db(mode,companyId);
  const amount=Math.round(n(x.amount)*100)/100,sourceCompanyId=Number(x.source_company_id||0),sourceAccountId=Number(x.source_account_id||0),accountId=Number(x.account_id||0);
  if(amount<=0)throw Error('Receipt amount must be greater than zero');if(!x.receipt_date||!accountId)throw Error('Receipt date and receiving account are required');
  const acc=d.prepare('SELECT * FROM company_accounts WHERE id=? AND active=1').get(accountId) as any;if(!acc)throw Error('Receiving account not found or inactive');
  let sourceDb:any=null,sourceAccount:any=null,sourceCompany:any=null;
  if(sourceCompanyId){
   if(sourceCompanyId===companyId)throw Error('Choose a different source organization.');
   const role=String(req.headers.get('x-aksh-role')||'');let menu:string[]=[];try{menu=JSON.parse(req.headers.get('x-aksh-menu')||'[]')}catch{}if(role!=='ADMIN'&&!menu.includes('money-out'))throw Error('Inter-company Money In also posts Money Out in the source organization, so the user must have Money Out permission.');
   const ad=adminDb(),who=String(req.headers.get('x-aksh-user')||'');
   if(role==='ADMIN')sourceCompany=ad.prepare('SELECT id,name,code FROM companies WHERE id=? AND active=1').get(sourceCompanyId) as any;
   else {const u=ad.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(who) as any;if(u&&ad.prepare(`SELECT 1 FROM user_companies WHERE user_id=? AND company_id=? AND ${mode==='TEST'?'can_test=1':'can_live=1'}`).get(u.id,sourceCompanyId))sourceCompany=ad.prepare('SELECT id,name,code FROM companies WHERE id=? AND active=1').get(sourceCompanyId) as any;}
   if(!sourceCompany)throw Error('Source organization is not mapped to this user in the selected environment.');
   sourceDb=db(mode,sourceCompanyId);sourceAccount=sourceDb.prepare('SELECT id,account_name FROM company_accounts WHERE id=? AND active=1').get(sourceAccountId) as any;
   if(!sourceAccount)throw Error('Select an active bank/cash account in the source organization.');
  }
  const no=String(x.receipt_no||'').trim()||`REC-${String(x.receipt_date).replaceAll('-','')}-${String((d.prepare('SELECT COUNT(*) c FROM money_in WHERE receipt_date=?').get(x.receipt_date) as any).c+1).padStart(4,'0')}`;
  const currentCompanyRow=sourceCompanyId?adminDb().prepare('SELECT name FROM companies WHERE id=?').get(companyId) as {name?:string}|undefined:undefined;const destinationCompanyName=String(currentCompanyRow?.name||`Company ${companyId}`);
  const receiptType=sourceCompanyId?'INTERCOMPANY_RECEIPT':String(x.receipt_type||'OTHER_RECEIPT'),partyId=sourceCompanyId?null:(x.party_id?Number(x.party_id):null),narration=String(x.narration||(sourceCompanyId?`Inter-company receipt from ${sourceCompany.name}`:receiptType));
  const id=d.transaction(()=>{const r=d.prepare(`INSERT INTO money_in(receipt_no,receipt_date,account_id,amount,receipt_type,party_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(no,x.receipt_date,accountId,amount,receiptType,partyId,x.reference_no||'',narration);const receiptId=Number(r.lastInsertRowid);d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(accountId,x.receipt_date,'CREDIT',amount,'MONEY_IN',receiptId,no,narration);if(partyId)d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,debit,narration) VALUES(?,?,?,?,?,?,?)`).run(partyId,x.receipt_date,'RECEIPT',receiptId,no,amount,narration);return receiptId;})();
  if(sourceCompanyId&&sourceDb){
   let sourceMoneyOutId:number|undefined;
   try{
    const sourcePaymentNo=`ICOUT-${String(x.receipt_date).replaceAll('-','')}-${String(id).padStart(6,'0')}`;
    sourceMoneyOutId=sourceDb.transaction(()=>{const out=sourceDb.prepare(`INSERT INTO money_out(payment_no,payment_date,account_id,amount,out_type,party_id,loan_id,reference_no,narration,destination_company_id,destination_receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(sourcePaymentNo,x.receipt_date,sourceAccountId,amount,'OTHER',null,null,no,`Inter-company transfer to ${destinationCompanyName} · ${no}`,companyId,id);const outId=Number(out.lastInsertRowid);sourceDb.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(sourceAccountId,x.receipt_date,'DEBIT',amount,'MONEY_OUT',outId,sourcePaymentNo,`Inter-company transfer to ${destinationCompanyName} · ${no}`);try{sourceDb.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'CREATE','INTERCOMPANY_MONEY_OUT',outId,JSON.stringify({sourceCompanyId,destinationCompanyId:companyId,destinationReceiptId:id,amount,mode}));}catch{}return outId;})();
    d.prepare('UPDATE money_in SET source_company_id=?,source_money_out_id=? WHERE id=?').run(sourceCompanyId,sourceMoneyOutId,id);
   }catch(targetError:any){if(sourceMoneyOutId){try{sourceDb.transaction(()=>{sourceDb.prepare("UPDATE money_out SET status='REVERSED' WHERE id=?").run(sourceMoneyOutId);sourceDb.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(sourceAccountId,x.receipt_date,'CREDIT',amount,'REVERSAL',sourceMoneyOutId,`ICOUT-${String(x.receipt_date).replaceAll('-','')}-${String(id).padStart(6,'0')}`,'Compensating reversal after inter-company receipt linkage failure')})();}catch{}}try{d.transaction(()=>{d.prepare("UPDATE money_in SET status='REVERSED' WHERE id=?").run(id);d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(accountId,x.receipt_date,'DEBIT',amount,'REVERSAL',id,no,'Compensating reversal after inter-company posting failure')})();}catch{}throw targetError;}
  }
  return NextResponse.json({ok:true,id,receiptNo:no,intercompany:!!sourceCompanyId,source_company_id:sourceCompanyId||null,message:sourceCompanyId?'Money In posted and matching Money Out created in the source organization.':'Money In receipt posted.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Money-in posting failed.'},{status:400})}
}
const wrapped=withPostgresSQLiteBridge(__bridge_POST);export async function POST(req:Request){return wrapped(req)}
