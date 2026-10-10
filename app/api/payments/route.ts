import { sessionMode } from '../../../lib/db';
import {NextResponse} from 'next/server';
import {db,Mode} from '../../../lib/db';
import {n} from '../../../lib/utils';
import {decideTds} from '../../../lib/tds';

function companyId(req:Request,x:any){return Number(req.headers.get('x-aksh-company-id')||x.company_id||1)}
function normalizeAllocations(d:any,partyId:number,raw:any[],paymentId:number|null,gross:number){
  const requested=Array.isArray(raw)?raw:[];
  if(!requested.length)return [];
  const seen=new Set<number>(); let total=0; const out:any[]=[];
  for(const item of requested){
    const purchaseId=Number(item.purchase_id); const amount=Math.round(n(item.amount));
    if(!purchaseId||amount<=0||seen.has(purchaseId))continue;
    const p=d.prepare(`SELECT id,party_id,net_payable,status,COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=purchases.id AND pay.status='POSTED' AND (? IS NULL OR pay.id<>?),0) outstanding_paid FROM purchases WHERE id=?`).get(paymentId,paymentId,purchaseId) as any;
    if(!p)throw Error('Selected purchase bill was not found');
    if(Number(p.party_id)!==partyId)throw Error('Every selected bill must belong to the selected party');
    if(String(p.status)!=='POSTED')throw Error('Only posted purchase bills can be allocated');
    const due=Math.max(0,Math.round(Number(p.net_payable)-Number(p.outstanding_paid||0)));
    if(amount>due)throw Error(`Allocation for bill ${purchaseId} exceeds its outstanding amount of ₹${due.toLocaleString('en-IN')}`);
    if(total+amount>gross)throw Error('Bill allocations cannot exceed the payment settlement amount');
    seen.add(purchaseId);total+=amount;out.push({purchase_id:purchaseId,amount});
  }
  return out;
}
function autoAllocations(d:any,partyId:number,gross:number,paymentId:number|null){
  const rows=d.prepare(`SELECT p.id,p.net_payable-COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED' AND (? IS NULL OR pay.id<>?),0) due FROM purchases p WHERE p.party_id=? AND p.status='POSTED' AND p.net_payable>COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED' AND (? IS NULL OR pay.id<>?),0) ORDER BY p.purchase_date,p.id`).all(paymentId,paymentId,partyId,paymentId) as any[];
  let remain=Math.max(0,Math.round(gross)); const out:any[]=[]; for(const p of rows){if(remain<=0)break;const a=Math.min(remain,Math.max(0,Math.round(p.due)));if(a>0){out.push({purchase_id:Number(p.id),amount:a});remain-=a}} return out;
}
function replaceAllocations(d:any,paymentId:number,partyId:number,gross:number,raw:any,automatic=true){
  const hasExplicit=Array.isArray(raw);
  const allocations=hasExplicit?normalizeAllocations(d,partyId,raw,paymentId,gross):(automatic?autoAllocations(d,partyId,gross,paymentId):[]);
  d.prepare('DELETE FROM payment_allocations WHERE payment_id=?').run(paymentId);
  const ins=d.prepare('INSERT INTO payment_allocations(payment_id,purchase_id,amount) VALUES(?,?,?)');
  for(const a of allocations)ins.run(paymentId,a.purchase_id,a.amount);
  return {allocations,allocated:allocations.reduce((sum,a)=>sum+Number(a.amount),0)};
}
function accountBalance(d:any,id:number,excludePaymentId:number|null=null){
  const row=d.prepare(`SELECT a.opening_balance+COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id AND (? IS NULL OR NOT (t.reference_type='PAYMENT' AND t.reference_id=?))),0) balance FROM company_accounts a WHERE a.id=? AND a.active=1`).get(excludePaymentId,excludePaymentId,id) as any; return row?Number(row.balance):null;
}
function paymentPayload(x:any,old:any){return {payment_no:String(x.payment_no||old?.payment_no||'').trim(),party_id:Number(x.party_id||old?.party_id),payment_date:String(x.payment_date||old?.payment_date||''),amount:Math.round(n(x.amount??old?.amount)),mode:String(x.mode||old?.mode||'BANK'),company_account_id:x.company_account_id??old?.company_account_id??null,broker_name:x.broker_name??old?.broker_name??'',broker_email:x.broker_email??old?.broker_email??'',bank_name:x.bank_name??old?.bank_name??'',utr:x.utr??old?.utr??'',notes:x.notes??old?.notes??''}}

export async function POST(req:Request){
 try{
  const x=await req.json(); const d=db(sessionMode(req),companyId(req,x)); const v=paymentPayload(x,null);
  if(!v.party_id||!v.payment_date||v.amount<=0)throw Error('Party, payment date and amount are required');
  const party=d.prepare('SELECT * FROM parties WHERE id=? AND active=1').get(v.party_id) as any;if(!party)throw Error('Party not found or inactive');
  if(['BANK','CASH'].includes(v.mode)&&!Number(v.company_account_id))throw Error('Select your bank/cash account before posting the payment');
  const dec=decideTds(d,party,v.payment_date,v.amount); const tdsRate=dec.rate; const tdsAmount=Math.round(dec.base*tdsRate/100); const netPaid=Math.max(0,v.amount-tdsAmount);
  const paymentNo=(String(x.payment_no||'').trim())||(()=>{const c=d.prepare('SELECT COUNT(*) c FROM payments WHERE payment_date=?').get(v.payment_date) as any;return `PAY-${v.payment_date.replaceAll('-','')}-${String(Number(c?.c||0)+1).padStart(4,'0')}`})();
  const result=d.transaction(()=>{const r=d.prepare('INSERT INTO payments(payment_no,party_id,payment_date,amount,tds_rate,tds_amount,net_paid,broker_name,broker_email,mode,company_account_id,bank_name,utr,notes,tds_base,tds_rule) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(paymentNo,v.party_id,v.payment_date,v.amount,tdsRate,tdsAmount,netPaid,v.broker_name,v.broker_email,v.mode,v.company_account_id,v.bank_name,v.utr,v.notes,dec.base,dec.rule);const id=Number(r.lastInsertRowid);let allocated=replaceAllocations(d,id,v.party_id,v.amount,x.allocations,true);if(['BANK','CASH'].includes(v.mode)){const bal=accountBalance(d,Number(v.company_account_id));if(bal===null)throw Error('Selected company bank/cash account was not found or is inactive');if(bal<netPaid)throw Error(`Insufficient balance in selected account. Available ₹${bal.toLocaleString('en-IN')}`);d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(v.company_account_id,v.payment_date,'DEBIT',netPaid,'PAYMENT',id,paymentNo,`Payment to ${party.name}`);}d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,debit,narration) VALUES(?,?,?,?,?,?,?)`).run(v.party_id,v.payment_date,'PAYMENT',id,paymentNo,v.amount,'Payment');return {id,allocated:allocated.allocated}})();
  return NextResponse.json({ok:true,paymentNo,allocated:result.allocated,tdsRate,tdsAmount,netPaid,tdsBase:dec.base,tdsRule:dec.rule,id:result.id});
 }catch(e:any){const msg=String(e?.message||e);return NextResponse.json({error:msg.includes('UNIQUE constraint failed: payments.payment_no')?'Payment number already exists. Leave Payment Number blank for automatic numbering.':msg},{status:400})}
}

export async function PUT(req:Request){
 try{
  const x=await req.json(); const d=db(sessionMode(req),companyId(req,x)); const id=Number(x.id);if(!id)throw Error('Payment id is required');
  const old=d.prepare('SELECT * FROM payments WHERE id=?').get(id) as any;if(!old)throw Error('Payment not found');if(old.status!=='POSTED')throw Error('Only posted payments can be edited');
  const v=paymentPayload(x,old); if(!v.payment_no)throw Error('Payment number is required'); if(!v.party_id||!v.payment_date||v.amount<=0)throw Error('Party, payment date and amount are required');
  const party=d.prepare('SELECT * FROM parties WHERE id=? AND active=1').get(v.party_id) as any;if(!party)throw Error('Party not found or inactive');
  const dec=decideTds(d,party,v.payment_date,v.amount);const tdsAmount=Math.round(dec.base*dec.rate/100);const netPaid=Math.max(0,v.amount-tdsAmount);
  const result=d.transaction(()=>{
    const oldTx=d.prepare("SELECT id,account_id,amount FROM account_transactions WHERE reference_type='PAYMENT' AND reference_id=? LIMIT 1").get(id) as any;
    if(['BANK','CASH'].includes(v.mode)&&!Number(v.company_account_id))throw Error('Select your bank/cash account before saving the payment');
    if(['BANK','CASH'].includes(v.mode)){const bal=accountBalance(d,Number(v.company_account_id),id);if(bal===null)throw Error('Selected company bank/cash account was not found or is inactive');if(bal<netPaid)throw Error(`Insufficient balance in selected account. Available ₹${bal.toLocaleString('en-IN')}`);}
    d.prepare(`UPDATE payments SET payment_no=?,party_id=?,payment_date=?,amount=?,tds_rate=?,tds_amount=?,net_paid=?,broker_name=?,broker_email=?,mode=?,company_account_id=?,bank_name=?,utr=?,notes=?,tds_base=?,tds_rule=? WHERE id=?`).run(v.payment_no,v.party_id,v.payment_date,v.amount,dec.rate,tdsAmount,netPaid,v.broker_name,v.broker_email,v.mode,v.company_account_id,v.bank_name,v.utr,v.notes,dec.base,dec.rule,id);
    const alloc=replaceAllocations(d,id,v.party_id,v.amount,x.allocations,false);
    d.prepare("DELETE FROM ledger WHERE entry_type='PAYMENT' AND reference_id=?").run(id);d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,debit,narration) VALUES(?,?,?,?,?,?,?)`).run(v.party_id,v.payment_date,'PAYMENT',id,old.payment_no,v.amount,'Payment (edited)');
    if(oldTx){d.prepare('DELETE FROM account_transactions WHERE id=?').run(oldTx.id)}
    if(['BANK','CASH'].includes(v.mode))d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(v.company_account_id,v.payment_date,'DEBIT',netPaid,'PAYMENT',id,old.payment_no,`Payment to ${party.name}`);
    return {allocated:alloc.allocated};
  })();
  return NextResponse.json({ok:true,id,paymentNo:old.payment_no,allocated:result.allocated,tdsRate:dec.rate,tdsAmount,netPaid});
 }catch(e:any){return NextResponse.json({error:String(e?.message||e)},{status:400})}
}
