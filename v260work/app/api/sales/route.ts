import { NextResponse } from 'next/server';
import { db, Mode } from '../../../lib/db';
import { n } from '../../../lib/utils';

function calc(x:any){
  const base=n(x.taxable_value);
  const discount=Math.round(base*n(x.discount_pct)/100*100)/100;
  // Business rule requested: discount amount is added to the base receivable value.
  const receivableBase=base+discount;
  const rate=Math.max(0,n(x.gst_rate));
  let cgst=0,sgst=0,igst=0;
  if(x.gst_type==='IGST') igst=Math.round(receivableBase*rate)/100;
  else if(x.gst_type==='CGST_SGST'){cgst=Math.round(receivableBase*rate/2)/100;sgst=Math.round(receivableBase*rate/2)/100;}
  const total=receivableBase+cgst+sgst+igst;
  return {discount,receivableBase,cgst,sgst,igst,total};
}
function dueDate(date:string,days:any){const d=Math.max(0,Math.floor(n(days)));if(!d)return '';const x=new Date(date+'T00:00:00');x.setDate(x.getDate()+d);return x.toISOString().slice(0,10)}
export async function POST(req:Request){try{
 const x=await req.json();const d=await db(x.mode as Mode, Number(req.headers.get('x-aksh-company-id')||x.company_id||1));if(!x.invoice_no||!x.invoice_date||!x.customer_name||n(x.taxable_value)<=0)throw Error('Invoice number, date, customer and taxable value are required');
 const c=calc(x);const days=Math.max(0,Math.floor(n(x.due_days)));const due=x.due_date||dueDate(x.invoice_date,days);
 await d.prepare(`INSERT INTO sales(invoice_no,invoice_date,customer_name,customer_gstin,place_of_supply,invoice_type,hsn,description,taxable_value,discount_pct,discount_amount,receivable_base,gst_rate,cgst,sgst,igst,total_value,due_days,due_date,cost_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(x.invoice_no,x.invoice_date,x.customer_name,x.customer_gstin||'',x.place_of_supply||'',x.invoice_type||'B2B',x.hsn||'',x.description||'',n(x.taxable_value),n(x.discount_pct),c.discount,c.receivableBase,n(x.gst_rate),c.cgst,c.sgst,c.igst,c.total,days,due,n(x.cost_amount));
 return NextResponse.json({ok:true,...c,dueDate:due});
}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}
export async function PUT(req:Request){try{
 const x=await req.json();const d=await db(x.mode as Mode, Number(req.headers.get('x-aksh-company-id')||x.company_id||1));const id=Number(x.id);const existing=await d.prepare('SELECT * FROM sales WHERE id=?').get(id) as any;if(!existing)throw Error('Sales bill not found');if(existing.received)throw Error('Received invoices cannot be edited. Reverse/correct them instead.');
 if(!x.invoice_no||!x.invoice_date||!x.customer_name||n(x.taxable_value)<=0)throw Error('Invoice number, date, customer and taxable value are required');
 const c=calc(x);const days=Math.max(0,Math.floor(n(x.due_days)));const due=x.due_date||dueDate(x.invoice_date,days);
 await d.prepare(`UPDATE sales SET invoice_no=?,invoice_date=?,customer_name=?,customer_gstin=?,place_of_supply=?,invoice_type=?,hsn=?,description=?,taxable_value=?,discount_pct=?,discount_amount=?,receivable_base=?,gst_rate=?,cgst=?,sgst=?,igst=?,total_value=?,due_days=?,due_date=?,cost_amount=? WHERE id=?`).run(x.invoice_no,x.invoice_date,x.customer_name,x.customer_gstin||'',x.place_of_supply||'',x.invoice_type||'B2B',x.hsn||'',x.description||'',n(x.taxable_value),n(x.discount_pct),c.discount,c.receivableBase,n(x.gst_rate),c.cgst,c.sgst,c.igst,c.total,days,due,n(x.cost_amount),id);
 return NextResponse.json({ok:true,...c,dueDate:due});
}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}
