import { sessionMode } from '../../../lib/db';
import { NextResponse } from 'next/server';
import { db, Mode } from '../../../lib/db';
import { n } from '../../../lib/utils';

function balance(d:any, id:number){
  const row=d.prepare(`SELECT a.opening_balance + COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id),0) balance FROM company_accounts a WHERE a.id=? AND a.active=1`).get(id) as any;
  return row ? Number(row.balance||0) : null;
}

export async function GET(req:Request){
  try{
    const u=new URL(req.url);
    const mode = sessionMode(req);
    const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);
    const d=db(mode,companyId);
    const rows=d.prepare(`
      SELECT m.*, fa.account_name from_account_name, ta.account_name to_account_name
      FROM account_movements m
      JOIN company_accounts fa ON fa.id=m.from_account_id
      LEFT JOIN company_accounts ta ON ta.id=m.to_account_id
      ORDER BY m.movement_date DESC,m.id DESC LIMIT 500
    `).all();
    return NextResponse.json({movements:rows});
  }catch(e:any){return NextResponse.json({error:e.message},{status:500})}
}

export async function POST(req:Request){
  try{
    const x=await req.json();
    const mode = sessionMode(req);
    const companyId=Number(req.headers.get('x-aksh-company-id')||x.company_id||1);
    const d=db(mode,companyId);
    const type=String(x.movement_type||'').toUpperCase();
    const fromId=Number(x.from_account_id||0);
    const toId=Number(x.to_account_id||0);
    const amount=Math.round(n(x.amount));
    if(!['WITHDRAWAL','TRANSFER'].includes(type)) throw Error('Select Withdrawal or Transfer.');
    if(!x.movement_date) throw Error('Date is required.');
    if(amount<=0) throw Error('Amount must be greater than zero.');
    if(!fromId) throw Error('Select the account from which money is leaving.');
    if(type==='TRANSFER' && !toId) throw Error('Select the destination account.');
    if(type==='TRANSFER' && fromId===toId) throw Error('Source and destination accounts must be different.');
    const from=d.prepare('SELECT * FROM company_accounts WHERE id=? AND active=1').get(fromId) as any;
    if(!from) throw Error('Source account not found or inactive.');
    const fromBalance=balance(d,fromId);
    if(fromBalance===null) throw Error('Unable to calculate source account balance.');
    if(fromBalance<amount) throw Error(`Insufficient balance in selected account. Available ₹${fromBalance.toLocaleString('en-IN')}`);
    let to:any=null;
    if(type==='TRANSFER'){
      to=d.prepare('SELECT * FROM company_accounts WHERE id=? AND active=1').get(toId) as any;
      if(!to) throw Error('Destination account not found or inactive.');
    }
    const no=String(x.movement_no||'').trim() || `${type==='TRANSFER'?'TRF':'WDL'}-${String(x.movement_date).replaceAll('-','')}-${String((d.prepare('SELECT COUNT(*) c FROM account_movements WHERE movement_date=? AND movement_type=?').get(x.movement_date,type) as any).c+1).padStart(4,'0')}`;
    const tx=d.transaction(()=>{
      const r=d.prepare(`INSERT INTO account_movements(movement_no,movement_type,movement_date,from_account_id,to_account_id,amount,reference_no,narration,status) VALUES(?,?,?,?,?,?,?,?,?)`).run(no,type,x.movement_date,fromId,type==='TRANSFER'?toId:null,amount,x.reference_no||'',x.narration||'', 'POSTED');
      d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(fromId,x.movement_date,'DEBIT',amount,type,r.lastInsertRowid,no,x.narration||`${type==='TRANSFER'?'Transfer to':'Withdrawal from'} ${from.account_name}`);
      if(type==='TRANSFER') d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(toId,x.movement_date,'CREDIT',amount,type,r.lastInsertRowid,no,x.narration||`Transfer from ${from.account_name}`);
      return Number(r.lastInsertRowid);
    });
    return NextResponse.json({ok:true,id:tx(),movementNo:no,movementType:type,amount});
  }catch(e:any){return NextResponse.json({error:e.message},{status:400})}
}
