import { NextResponse } from 'next/server';
import { db, Mode } from '../../../lib/db';
import { n } from '../../../lib/utils';
export async function POST(req: Request) {
  try {
    const x=await req.json(); const d=await db(x.mode as Mode, Number(req.headers.get('x-aksh-company-id')||x.company_id||1)); const id=Number(x.sale_id); const amount=n(x.amount); const accountId=Number(x.account_id||0);
    const sale=await d.prepare('SELECT * FROM sales WHERE id=? AND status=\'POSTED\'').get(id) as any;
    if(!sale) throw Error('Sales invoice not found'); if(amount<=0) throw Error('Receipt amount must be greater than zero'); if(!accountId) throw Error('Select the receiving bank/cash account');
    const already=n(sale.received_amount); const remaining=Math.max(0,n(sale.total_value)-already); if(amount>remaining+0.01) throw Error(`Receipt exceeds outstanding amount of ₹${remaining.toLocaleString('en-IN')}`);
    const date=x.received_date||new Date().toISOString().slice(0,10);
    d.transaction(async ()=>{
      await d.prepare('UPDATE sales SET received_amount=received_amount+?,received=CASE WHEN received_amount+? >= total_value THEN 1 ELSE 0 END,received_date=?,receipt_account_id=? WHERE id=?').run(amount,amount,date,accountId,id);
      await d.prepare(`INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id,reference_no,narration) VALUES(?,?,?,?,?,?,?,?)`).run(accountId,date,'CREDIT',amount,'RECEIPT',id,sale.invoice_no,`Receipt against ${sale.invoice_no}`);
    })();
    return NextResponse.json({ok:true,remaining:remaining-amount,received:already+amount});
  } catch(e:any){return NextResponse.json({error:e.message},{status:400});}
}
