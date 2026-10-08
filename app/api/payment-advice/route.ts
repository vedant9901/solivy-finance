import {db,Mode,adminDb} from '../../../lib/db';
import {jsPDF} from 'jspdf';

const clean=(v:any)=>String(v??'').trim();
const num=(v:any)=>Number(v||0);
const money=(v:any)=>`INR ${Math.round(num(v)).toLocaleString('en-IN')}`;
const moneyPlain=(v:any)=>Math.round(num(v)).toLocaleString('en-IN');
const dateText=(v:any)=>{const s=clean(v);if(!s)return '';const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return s;const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return `${m[3]}-${months[Number(m[2])-1]||m[2]}-${m[1]}`};
function words(n:number){const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];const under=(x:number):string=>x<20?ones[x]:x<100?tens[Math.floor(x/10)]+(x%10?' '+ones[x%10]:''):ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+under(x%100):'');n=Math.round(Math.max(0,n));if(n===0)return 'Zero';let s='';const c=Math.floor(n/1e7);n%=1e7;const l=Math.floor(n/1e5);n%=1e5;const t=Math.floor(n/1e3);n%=1e3;if(c)s+=under(c)+' Crore ';if(l)s+=under(l)+' Lakh ';if(t)s+=under(t)+' Thousand ';if(n)s+=under(n);return s.trim();}
const on=(s:any,k:string,def=true)=>s?.[k]===undefined?def:s[k]!==false;
function text(doc:any,v:any,x:number,y:number,w?:number,opts:any={}){const s=clean(v);if(!s)return 0;const lines=w?doc.splitTextToSize(s,w):[s];doc.text(lines,x,y,opts);return lines.length;}
function field(doc:any,label:string,value:any,x:number,y:number,valueX:number,maxW=65){if(!clean(value))return y;doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.setTextColor(90,98,110);doc.text(label,x,y);doc.setTextColor(25,30,40);doc.setFont('helvetica','bold');doc.text(clean(value),valueX,y,{maxWidth:maxW});return y+5;}
function sectionTitle(doc:any,title:string,x:number,y:number,w:number){doc.setFillColor(244,246,249);doc.roundedRect(x,y-5,w,8,1.5,1.5,'F');doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(25,35,50);doc.text(title,x+3,y);return y+7;}

export async function GET(req:Request){
 try{
  const u=new URL(req.url);const mode=(u.searchParams.get('mode')||'LIVE') as Mode;const id=Number(u.searchParams.get('id'));const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);if(!id)throw Error('Payment id is required');
  const d=db(mode,companyId);
  const p=d.prepare(`SELECT p.*,x.name party_name,x.address,x.contact,x.gst,x.pan,b.bank_name,b.account_number,b.ifsc,b.branch,a.account_name company_account_name FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=x.id ORDER BY is_primary DESC,id LIMIT 1) LEFT JOIN company_accounts a ON a.id=p.company_account_id WHERE p.id=?`).get(id) as any;
  if(!p)throw Error('Payment not found');
  const allocations=d.prepare(`SELECT a.amount allocation_amount,q.id purchase_id,q.sample_no,q.invoice_no,q.purchase_date,q.goods_description,q.bags_qty,q.gross_weight,q.net_weight,q.rate,q.gross_amount,q.unload_charge,q.freight,q.moisture,q.discount_pct,q.discount_amount,q.driver_rokdi,q.quality_deduct_amount,q.other_charges,q.net_payable,q.net_payable-COALESCE((SELECT SUM(a2.amount) FROM payment_allocations a2 JOIN payments p2 ON p2.id=a2.payment_id WHERE a2.purchase_id=q.id AND p2.status='POSTED' AND p2.id<>?),0) outstanding_after FROM payment_allocations a JOIN purchases q ON q.id=a.purchase_id WHERE a.payment_id=? ORDER BY q.purchase_date,q.id`).all(id,id) as any[];
  const company=adminDb().prepare('SELECT id,name,code,address,city,state,email,gstin,pan,financial_year FROM companies WHERE id=?').get(companyId) as any;if(!company)throw Error('Company not found');
  const raw=d.prepare('SELECT payment_advice_settings FROM company_settings WHERE id=1').get() as any;let s:any={};try{s=JSON.parse(raw?.payment_advice_settings||'{}')}catch{}

  const doc=new jsPDF({unit:'mm',format:'a4'});const L=14,R=196,W=R-L;let y=14;
  doc.setTextColor(25,30,40);doc.setDrawColor(210,215,222);doc.setLineWidth(.3);

  // Professional header
  doc.setFont('helvetica','bold');doc.setFontSize(16);doc.text(clean(company.name)||'SOLIVY',L,y);
  doc.setFont('helvetica','normal');doc.setFontSize(7.5);y+=4.5;
  const companyLines=[company.address,[company.city,company.state].filter(Boolean).join(', '),company.email&&`E-Mail: ${company.email}`,company.gstin&&`GSTIN: ${company.gstin}`].filter(Boolean).map(clean);
  for(const v of companyLines){doc.text(v,L,y);y+=3.5;}
  doc.setFont('helvetica','bold');doc.setFontSize(15);doc.setTextColor(25,35,50);doc.text('PAYMENT ADVICE',R,17,{align:'right'});
  doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(75,82,94);doc.text(`Payment No: ${clean(p.payment_no)||id}`,R,23,{align:'right'});doc.text(`Payment Date: ${dateText(p.payment_date)}`,R,28,{align:'right'});
  doc.line(L,34,R,34);y=42;

  y=sectionTitle(doc,'PAYMENT DETAILS',L,y,W);
  const col2=108;let ly=y,ry=y;
  ly=field(doc,'Paid To',p.party_name,L,ly,L+42,55);ly=field(doc,'Payment Mode',p.mode,L,ly,L+42,55);if(on(s,'show_utr'))ly=field(doc,'UTR / Reference',clean(p.utr)||'—',L,ly,L+42,55);
  ry=field(doc,'Paid From',clean(p.company_account_name)||'—',col2,ry,col2+42,55);ry=field(doc,'Bank',p.bank_name,col2,ry,col2+42,55);if(clean(p.broker_name)&&on(s,'show_broker'))ry=field(doc,'Broker',p.broker_name,col2,ry,col2+42,55);
  y=Math.max(ly,ry)+3;doc.line(L,y,R,y);y+=8;

  // Party / bank cards
  const cardTop=y-3, cardH=30, mid=105;
  doc.setFillColor(250,251,252);doc.roundedRect(L,cardTop,mid-L,cardH,1.5,1.5,'F');doc.roundedRect(mid+2,cardTop,R-mid-2,cardH,1.5,1.5,'F');
  doc.setFont('helvetica','bold');doc.setFontSize(8);doc.setTextColor(25,35,50);doc.text('SUPPLIER / PARTY',L+3,y+2);doc.text('BANK DETAILS',mid+5,y+2);
  doc.setFont('helvetica','normal');doc.setFontSize(7.5);let py=y+7;
  for(const v of [on(s,'show_party_address')&&p.address,on(s,'show_party_address')&&p.contact&&`Contact: ${p.contact}`,on(s,'show_party_gst')&&p.gst&&`GSTIN: ${p.gst}`,on(s,'show_party_pan')&&p.pan&&`PAN: ${p.pan}`].filter(Boolean)){text(doc,v,L+3,py,80);py+=4;}
  let by=y+7;for(const [k,v] of [['Bank',p.bank_name],['A/C',p.account_number],['IFSC',p.ifsc],['Branch',p.branch]]){if(clean(v)){doc.text(`${k}: ${v}`,mid+5,by);by+=4;}}
  y=cardTop+cardH+8;

  const grossSettlement=num(p.amount);const tds=num(p.tds_amount);const displayedNet=on(s,'include_tds_in_net')?num(p.net_paid||grossSettlement-tds):grossSettlement;const allocatedTotal=allocations.reduce((a,r)=>a+num(r.allocation_amount),0);const unallocated=Math.max(0,Math.round(grossSettlement-allocatedTotal));
  if(on(s,'show_allocations')){
   y=sectionTitle(doc,'BILL-WISE PAYMENT SETTLEMENT',L,y,W);
   for(const r of allocations){
    const deductions=[['Unload Charges',num(r.unload_charge),'show_unload'],['Freight',num(r.freight),'show_freight'],['Moisture',num(r.moisture),'show_moisture'],['Discount',num(r.discount_amount),'show_discount'],['Driver Rokdi',num(r.driver_rokdi),'show_driver_rokdi'],['Quality Deduct',num(r.quality_deduct_amount),'show_quality_deduct'],['Other Charges',num(r.other_charges),'show_other_charges']].filter((x:any)=>on(s,x[2])&&x[1]!==0) as [string,number,string][];
    const discountPct=num(r.discount_pct)>0?num(r.discount_pct):(num(r.gross_amount)>0?num(r.discount_amount)*100/num(r.gross_amount):0);
    const estimatedH=47+(on(s,'show_bags')&&num(r.bags_qty)>0?5:0)+(on(s,'show_description')&&clean(r.goods_description)?5:0)+(on(s,'show_purchase_date')?5:0)+(on(s,'show_quantity')?5:0)+(on(s,'show_gross_amount')?5:0)+(deductions.length*4.5)+(on(s,'show_net_payable')?5:0)+(on(s,'show_allocated')?5:0)+(on(s,'show_outstanding')?5:0);
    if(y+estimatedH>270){doc.addPage();y=18;y=sectionTitle(doc,'BILL-WISE PAYMENT SETTLEMENT — CONTINUED',L,y,W);}
    const boxTop=y-4;doc.setFillColor(248,250,252);doc.roundedRect(L,boxTop,W,estimatedH,2,2,'F');
    doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(25,35,50);doc.text(`${clean(r.invoice_no)||clean(r.sample_no)||'Bill'}${clean(r.sample_no)&&clean(r.invoice_no)?`  •  Sample: ${clean(r.sample_no)}`:''}`,L+4,y+2);doc.text(money(r.allocation_amount),R-4,y+2,{align:'right'});y+=9;
    doc.setDrawColor(220,224,230);doc.line(L+4,y-3,R-4,y-3);
    if(on(s,'show_purchase_date')){doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.setTextColor(85,92,104);doc.text('Purchase Date',L+4,y);doc.setTextColor(25,30,40);doc.setFont('helvetica','bold');doc.text(dateText(r.purchase_date)||'—',L+29,y);y+=5;}
    if(on(s,'show_description')&&clean(r.goods_description)){doc.setFont('helvetica','normal');doc.setTextColor(85,92,104);doc.text('Description',L+4,y);doc.setTextColor(25,30,40);text(doc,r.goods_description,L+29,y,150);y+=5;}
    const infoY=y;let x1=L+4;
    if(on(s,'show_bags')&&num(r.bags_qty)>0){doc.setFont('helvetica','normal');doc.setTextColor(85,92,104);doc.text('Bags / Packages',x1,y);doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text(num(r.bags_qty).toLocaleString('en-IN'),x1+27,y);x1+=47;}
    if(on(s,'show_quantity')){doc.setFont('helvetica','normal');doc.setTextColor(85,92,104);doc.text('Net Weight',x1,y);doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text(`${num(r.net_weight).toLocaleString('en-IN')} Kg`,x1+20,y);x1+=43;}
    if(on(s,'show_gross_weight')){doc.setFont('helvetica','normal');doc.setTextColor(85,92,104);doc.text('Gross Weight',x1,y);doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text(`${num(r.gross_weight).toLocaleString('en-IN')} Kg`,x1+23,y);x1+=47;}
    if(on(s,'show_rate')){doc.setFont('helvetica','normal');doc.setTextColor(85,92,104);doc.text('Rate / Kg',x1,y);doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text(money(r.rate),x1+18,y);}
    y+=6;
    if(on(s,'show_gross_amount')){doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text('Gross Amount',L+4,y);doc.setFont('helvetica','normal');doc.text(money(r.gross_amount),R-4,y,{align:'right'});y+=5;}
    for(const [label,val,key] of deductions){doc.setFont('helvetica','normal');doc.setTextColor(25,30,40);doc.text('Less:',L+4,y);let labelText=label;if(label==='Discount'&&on(s,'show_discount_pct')&&discountPct>0)labelText+=` (${discountPct.toFixed(2)}%)`;doc.text(labelText,L+18,y);doc.text(`(-) ${money(val)}`,R-4,y,{align:'right'});y+=4.5;}
    if(on(s,'show_net_payable')){doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text('Net Payable',L+4,y);doc.text(money(r.net_payable),R-4,y,{align:'right'});y+=4.8;}
    if(on(s,'show_allocated')){doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text('Payment Allocated',L+4,y);doc.text(money(r.allocation_amount),R-4,y,{align:'right'});y+=4.8;}
    if(on(s,'show_outstanding')){doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text('Outstanding After Payment',L+4,y);doc.text(money(Math.max(0,r.outstanding_after)),R-4,y,{align:'right'});y+=4.8;}
    y=boxTop+estimatedH+7;
   }
  }
  if(y+45>270){doc.addPage();y=18;}
  y=sectionTitle(doc,'SETTLEMENT SUMMARY',L,y,W);
  const summary:[string,any][]=[['Gross Settlement',grossSettlement]];if(on(s,'show_tds'))summary.push([`TDS Deducted (${num(p.tds_rate).toFixed(2)}%)`,tds]);summary.push(['Net Bank Payment',displayedNet]);if(on(s,'show_allocations')){summary.push(['Allocated to Bills',allocatedTotal]);summary.push(['Unallocated / Advance',unallocated]);}
  for(const [label,val] of summary){doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(45,52,64);doc.text(label,L,y);doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text(money(val),R,y,{align:'right'});y+=5.5;}
  if(on(s,'show_amount_words')){y+=4;doc.setFont('helvetica','bold');doc.setFontSize(8);doc.text('AMOUNT IN WORDS',L,y);doc.setFont('helvetica','normal');doc.setFontSize(8.5);text(doc,`${words(displayedNet)} Rupees Only`,L,y+5,W);y+=14;}
  if(on(s,'show_notes')&&clean(p.notes)){doc.setFont('helvetica','bold');doc.setFontSize(8);doc.text('NOTES',L,y);doc.setFont('helvetica','normal');text(doc,p.notes,L,y+5,W);y+=12;}
  doc.setDrawColor(215,219,225);doc.line(L,274,R,274);doc.setFont('helvetica','normal');doc.setFontSize(7);doc.setTextColor(105,110,120);doc.text('System-generated payment advice. This document is not a bank confirmation or tax certificate.',L,280);doc.setFont('helvetica','bold');doc.setTextColor(25,30,40);doc.text(clean(company.name)||'SOLIVY',R,280,{align:'right'});
  const bytes=new Uint8Array(doc.output('arraybuffer'));return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Payment-Advice-${clean(p.payment_no)||id}.pdf"`}});
 }catch(e:any){return new Response(String(e?.message||'Unable to generate payment advice'),{status:500})}
}
