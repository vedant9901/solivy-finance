import { sessionMode } from '../../../lib/db';
import { NextResponse } from 'next/server';
import { db, Mode } from '../../../lib/db';
import { n } from '../../../lib/utils';
export async function GET(req: Request) {
  try {
    const u=new URL(req.url); const mode = sessionMode(req); const d=db(mode,Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1));
    const rows = d.prepare(`SELECT a.*, a.opening_balance + COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id),0) balance FROM company_accounts a WHERE a.active=1 ORDER BY a.account_name`).all();
    return NextResponse.json({ accounts: rows });
  } catch (e:any) { return NextResponse.json({error:e.message},{status:500}); }
}
export async function DELETE(req: Request) {
  try { const u=new URL(req.url); const mode = sessionMode(req); const id=Number(u.searchParams.get('id')); const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1); const d=db(mode,companyId); const used=d.prepare('SELECT COUNT(*) c FROM account_transactions WHERE account_id=?').get(id) as any; if(Number(used?.c)>0) { d.prepare('UPDATE company_accounts SET active=0 WHERE id=?').run(id); return NextResponse.json({ok:true,deactivated:true}); } d.prepare('DELETE FROM company_accounts WHERE id=?').run(id); return NextResponse.json({ok:true}); } catch(e:any){return NextResponse.json({error:e.message},{status:400})} }
export async function POST(req: Request) {
  try {
    const x = await req.json(); const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id')||x.company_id||1));
    if (!x.account_name || !x.bank_name) throw Error('Account name and bank name are required');
    const accountNumber=String(x.account_number||'').trim();const ifsc=String(x.ifsc||'').trim().toUpperCase();if(accountNumber&&!/^\d{6,18}$/.test(accountNumber))throw Error('Bank account number must contain 6 to 18 digits');if(ifsc&&!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))throw Error('IFSC format is invalid');
    const opening = n(x.opening_balance);
    const tx = d.transaction(() => {
      const r = d.prepare(`INSERT INTO company_accounts(account_name,bank_name,account_number,ifsc,branch,account_type,opening_balance,opening_date) VALUES(?,?,?,?,?,?,?,?)`).run(x.account_name,x.bank_name,accountNumber,ifsc,x.branch||'',x.account_type||'BANK',opening,x.opening_date||new Date().toISOString().slice(0,10));
      return r;
    });
    const r=tx(); return NextResponse.json({ok:true,id:Number(r.lastInsertRowid)});
  } catch(e:any){return NextResponse.json({error:e.message},{status:400});}
}

export async function PUT(req:Request){try{const x=await req.json();const d=db(sessionMode(req), Number(req.headers.get('x-aksh-company-id')||x.company_id||1));const id=Number(x.id);if(!id||!x.account_name||!x.bank_name)throw Error('Account name and bank name are required');const accountNumber=String(x.account_number||'').trim();const ifsc=String(x.ifsc||'').trim().toUpperCase();if(accountNumber&&!/^\d{6,18}$/.test(accountNumber))throw Error('Bank account number must contain 6 to 18 digits');if(ifsc&&!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))throw Error('IFSC format is invalid');const used=d.prepare('SELECT COUNT(*) c FROM account_transactions WHERE account_id=?').get(id) as any;if(Number(used?.c)>0 && n(x.opening_balance)!==n((d.prepare('SELECT opening_balance FROM company_accounts WHERE id=?').get(id) as any)?.opening_balance))throw Error('Opening balance cannot be changed after transactions exist; use an adjustment transaction.');d.prepare('UPDATE company_accounts SET account_name=?,bank_name=?,account_number=?,ifsc=?,branch=?,account_type=?,opening_balance=?,opening_date=? WHERE id=?').run(x.account_name,x.bank_name,accountNumber,ifsc,x.branch||'',x.account_type||'BANK',n(x.opening_balance),x.opening_date||new Date().toISOString().slice(0,10),id);return NextResponse.json({ok:true})}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}
