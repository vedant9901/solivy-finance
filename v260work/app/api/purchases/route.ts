import { NextResponse } from 'next/server';
import { db, Mode } from '../../../lib/db';
import { purchaseCalc, n } from '../../../lib/utils';

function dueDate(date:string, days:any){
  const d=Math.max(0,Math.floor(n(days)));
  if(!d) return '';
  const x=new Date(date+'T00:00:00'); x.setDate(x.getDate()+d);
  return x.toISOString().slice(0,10);
}

async function ensureParty(d:any,id:number){
  if(!id) throw Error('Party is required');
  const p=await d.prepare('SELECT id,name,active FROM parties WHERE id=?').get(id) as any;
  if(!p) throw Error('Party not found');
  if(!p.active) throw Error('Selected party is inactive');
}

export async function POST(req:Request){
  try{
    const x=await req.json(); const d=await db(x.mode as Mode, Number(req.headers.get('x-aksh-company-id')||x.company_id||1));
    if(!String(x.sample_no||'').trim()||!String(x.purchase_date||'').trim()||n(x.net_weight)<=0||n(x.rate)<=0) throw Error('Sample number, purchase date, net weight and rate are required');
    await ensureParty(d,Number(x.party_id));
    const gstRate=Math.max(0,n(x.gst_rate));
    const gstTaxable=n(x.gst_taxable||0);
    const gstAmount=Math.round(gstTaxable*gstRate)/100;
    const c=purchaseCalc(x);
    const dueDays=Math.max(0,Math.floor(n(x.payment_due_days)));
    const dueDateValue=x.payment_due_date || dueDate(x.purchase_date,dueDays);
    const recvPartyId=Number(x.receivable_party_id||0);
    if(recvPartyId) await ensureParty(d,recvPartyId);
    const tx=d.transaction(async ()=>{
      const r=await d.prepare(`INSERT INTO purchases(sample_no,party_id,purchase_date,goods_description,bags_qty,invoice_no,hsn,gst_type,gst_rate,gst_taxable,gst_amount,gross_weight,net_weight,rate,freight,unload_charge,moisture,discount_pct,driver_rokdi,other_charges,quality_deduct_per_mt,gross_amount,discount_amount,quality_deduct_amount,total_deduction,net_payable,notes,payment_due_days,payment_due_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        x.sample_no,x.party_id,x.purchase_date,x.goods_description||'',n(x.bags_qty),x.invoice_no||'',x.hsn||'',x.gst_type||'NONE',gstRate,gstTaxable,gstAmount,n(x.gross_weight),n(x.net_weight),n(x.rate),n(x.freight),n(x.unload_charge),n(x.moisture),n(x.discount_pct),n(x.driver_rokdi),n(x.other_charges),n(x.quality_deduct_per_mt),c.gross_amount,c.discount_amount,c.quality_deduct_amount,c.total_deduction,c.net_payable,x.notes||'',dueDays,dueDateValue
      );
      await d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,credit,narration) VALUES(?,?,?,?,?,?,?)`).run(x.party_id,x.purchase_date,'PURCHASE',r.lastInsertRowid,x.sample_no,c.net_payable,'Purchase payable');
      if(recvPartyId){
        const rdDays=Math.max(0,Math.floor(n(x.receivable_due_days)));
        const rd=x.receivable_due_date || dueDate(x.purchase_date,rdDays);
        const receivableAmount=n(c.net_payable)+n(c.discount_amount)+n(x.other_charges);
        await d.prepare(`INSERT INTO financing_receivables(purchase_id,party_id,bill_no,bill_date,cost_amount,discount_amount,other_charges_profit,receivable_amount,due_days,due_date,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(Number(r.lastInsertRowid),recvPartyId,x.invoice_no||x.sample_no,x.purchase_date,c.net_payable,c.discount_amount,n(x.other_charges),receivableAmount,rdDays,rd,x.receivable_notes||'');
      }
      return Number(r.lastInsertRowid);
    });
    const id=await tx();
    return NextResponse.json({ok:true,id,calc:c,receivableAmount:recvPartyId?Number(c.net_payable)+Number(c.discount_amount)+Number(x.other_charges||0):0});
  }catch(e:any){const msg=String(e?.message||e);return NextResponse.json({error:msg.includes('UNIQUE constraint failed: purchases.sample_no')?'Sample number already exists. Use a unique sample number or edit the existing purchase.':msg},{status:400});}
}

export async function PUT(req:Request){
  try{
    const x=await req.json(); const d=await db(x.mode as Mode, Number(req.headers.get('x-aksh-company-id')||x.company_id||1)); const id=Number(x.id);
    const p=await d.prepare('SELECT * FROM purchases WHERE id=?').get(id) as any;
    if(!p) throw Error('Purchase not found');
    const alloc=await d.prepare('SELECT COUNT(*) c FROM payment_allocations WHERE purchase_id=?').get(id) as any;
    if(Number(alloc?.c||0)>0) throw Error('This purchase has payments allocated. Reverse/correct the payment first before editing.');
    if(!String(x.sample_no||'').trim()||!String(x.purchase_date||'').trim()||n(x.net_weight)<=0||n(x.rate)<=0) throw Error('Sample number, purchase date, net weight and rate are required');
    await ensureParty(d,Number(x.party_id));
    const c=purchaseCalc(x);
    const dueDays=Math.max(0,Math.floor(n(x.payment_due_days))); const dueDateValue=x.payment_due_date || dueDate(x.purchase_date,dueDays);
    const recvPartyId=Number(x.receivable_party_id||0); if(recvPartyId) await ensureParty(d,recvPartyId);
    const tx=d.transaction(async ()=>{
      await d.prepare(`UPDATE purchases SET sample_no=?,party_id=?,purchase_date=?,goods_description=?,bags_qty=?,invoice_no=?,hsn=?,gst_type=?,gst_rate=?,gst_taxable=?,gst_amount=?,gross_weight=?,net_weight=?,rate=?,freight=?,unload_charge=?,moisture=?,discount_pct=?,driver_rokdi=?,other_charges=?,quality_deduct_per_mt=?,gross_amount=?,discount_amount=?,quality_deduct_amount=?,total_deduction=?,net_payable=?,notes=?,payment_due_days=?,payment_due_date=? WHERE id=?`).run(x.sample_no,x.party_id,x.purchase_date,x.goods_description||'',n(x.bags_qty),x.invoice_no||'',x.hsn||'',x.gst_type||'NONE',n(x.gst_rate),n(x.gst_taxable),Math.round(n(x.gst_taxable)*n(x.gst_rate))/100,n(x.gross_weight),n(x.net_weight),n(x.rate),n(x.freight),n(x.unload_charge),n(x.moisture),n(x.discount_pct),n(x.driver_rokdi),n(x.other_charges),n(x.quality_deduct_per_mt),c.gross_amount,c.discount_amount,c.quality_deduct_amount,c.total_deduction,c.net_payable,x.notes||'',dueDays,dueDateValue,id);
      await d.prepare("DELETE FROM ledger WHERE entry_type='PURCHASE' AND reference_id=?").run(id);
      await d.prepare(`INSERT INTO ledger(party_id,entry_date,entry_type,reference_id,reference_no,credit,narration) VALUES(?,?,?,?,?,?,?)`).run(x.party_id,x.purchase_date,'PURCHASE',id,x.sample_no,c.net_payable,'Purchase payable');
      await d.prepare('DELETE FROM financing_receivables WHERE purchase_id=?').run(id);
      if(recvPartyId){const rdDays=Math.max(0,Math.floor(n(x.receivable_due_days)));const rd=x.receivable_due_date||dueDate(x.purchase_date,rdDays);await d.prepare(`INSERT INTO financing_receivables(purchase_id,party_id,bill_no,bill_date,cost_amount,discount_amount,other_charges_profit,receivable_amount,due_days,due_date,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,recvPartyId,x.invoice_no||x.sample_no,x.purchase_date,c.net_payable,c.discount_amount,n(x.other_charges),n(c.net_payable)+n(c.discount_amount)+n(x.other_charges),rdDays,rd,x.receivable_notes||'');}
    });
    await tx();
    return NextResponse.json({ok:true,calc:c});
  }catch(e:any){const msg=String(e?.message||e);return NextResponse.json({error:msg.includes('UNIQUE constraint failed: purchases.sample_no')?'Sample number already exists. Use a unique sample number or edit the existing purchase.':msg},{status:400});}
}
