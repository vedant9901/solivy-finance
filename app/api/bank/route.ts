import { NextResponse } from 'next/server';
import { db, sessionMode } from '../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
export const runtime='nodejs'; export const dynamic='force-dynamic';
async function handler(req:Request){try{
 const mode=sessionMode(req),url=new URL(req.url),company=Number(req.headers.get('x-aksh-company-id')||url.searchParams.get('company_id')||1),d=db(mode,company);
 d.exec(`CREATE TABLE IF NOT EXISTS bank_transaction_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, account_transaction_id INTEGER NOT NULL UNIQUE REFERENCES account_transactions(id) ON DELETE CASCADE, statement_date TEXT NOT NULL, statement_amount REAL NOT NULL, reference TEXT DEFAULT '', matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
 if(req.method==='GET'){
  const rows=d.prepare(`SELECT t.id transaction_id,t.transaction_date,t.transaction_type,t.amount,t.reference_type,t.reference_id,t.reference_no,t.narration,a.account_name,a.account_type,COALESCE(p.name,miParty.name,moParty.name,puParty.name,ipParty.name,frParty.name,sl.customer_name,'') party_name,m.id match_id,m.statement_date,m.statement_amount,m.reference statement_reference,m.matched_at FROM account_transactions t JOIN company_accounts a ON a.id=t.account_id LEFT JOIN payments pay ON UPPER(t.reference_type)='PAYMENT' AND pay.id=t.reference_id LEFT JOIN parties p ON p.id=pay.party_id LEFT JOIN money_in mi ON UPPER(t.reference_type) IN ('MONEY_IN','RECEIPT') AND mi.id=t.reference_id LEFT JOIN parties miParty ON miParty.id=mi.party_id LEFT JOIN money_out mo ON UPPER(t.reference_type)='MONEY_OUT' AND mo.id=t.reference_id LEFT JOIN parties moParty ON moParty.id=mo.party_id LEFT JOIN purchases pu ON UPPER(t.reference_type)='PURCHASE' AND pu.id=t.reference_id LEFT JOIN parties puParty ON puParty.id=pu.party_id LEFT JOIN interest_payments ip ON UPPER(t.reference_type) IN ('INTEREST','INTEREST_PAYMENT') AND ip.id=t.reference_id LEFT JOIN parties ipParty ON ipParty.id=ip.party_id LEFT JOIN financing_receivables fr ON UPPER(t.reference_type) IN ('RECEIVABLE','FINANCE_RECEIPT') AND fr.id=t.reference_id LEFT JOIN parties frParty ON frParty.id=fr.party_id LEFT JOIN sales sl ON UPPER(t.reference_type) IN ('SALE_RECEIPT','SALES_RECEIPT') AND sl.id=t.reference_id LEFT JOIN bank_transaction_matches m ON m.account_transaction_id=t.id ORDER BY t.transaction_date DESC,t.id DESC`).all() as any[];
  return NextResponse.json({transactions:rows,unmatched:rows.filter(r=>!r.match_id),matched:rows.filter(r=>!!r.match_id)});
 }
 const x=await req.json(),transactionId=Number(x.transaction_id);
 if(!Number.isSafeInteger(transactionId)||transactionId<=0)return NextResponse.json({error:'Select a valid recorded transaction.'},{status:400});
 const tx=d.prepare('SELECT id,transaction_date,amount FROM account_transactions WHERE id=?').get(transactionId) as any;
 if(!tx)return NextResponse.json({error:'Recorded transaction not found.'},{status:404});
 const date=String(x.statement_date||''),amount=Number(x.statement_amount);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(amount)||amount<0)return NextResponse.json({error:'Enter a valid bank statement date and amount.'},{status:400});
 const diff=Math.abs(Number(tx.amount)-amount);
 if(diff>0.01&&!x.allow_difference)return NextResponse.json({error:`Statement amount differs from recorded amount by ${diff.toFixed(2)}. Confirm the difference to match anyway.`,difference:diff},{status:409});
 d.prepare('INSERT INTO bank_transaction_matches(account_transaction_id,statement_date,statement_amount,reference) VALUES(?,?,?,?) ON CONFLICT(account_transaction_id) DO UPDATE SET statement_date=excluded.statement_date,statement_amount=excluded.statement_amount,reference=excluded.reference,matched_at=CURRENT_TIMESTAMP').run(transactionId,date,amount,String(x.reference||''));
 return NextResponse.json({ok:true,message:'Transaction matched.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Bank matching failed.'},{status:400})}}
const wrapped=withPostgresSQLiteBridge(handler);export async function GET(req:Request){return wrapped(req)}export async function POST(req:Request){return wrapped(req)}
