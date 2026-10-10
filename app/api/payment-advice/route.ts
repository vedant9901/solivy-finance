import { sessionMode } from '../../../lib/db';
import {db,Mode,adminDb} from '../../../lib/db';
import {jsPDF} from 'jspdf';

const clean=(v:any)=>String(v??'').trim();
const num=(v:any)=>Number(v||0);
const money=(v:any)=>`INR ${Math.round(num(v)).toLocaleString('en-IN')}`;
const dateText=(v:any)=>{const s=clean(v);if(!s)return '';const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return s;const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return `${m[3]}-${months[Number(m[2])-1]||m[2]}-${m[1]}`};
function words(n:number){const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];const under=(x:number):string=>x<20?ones[x]:x<100?tens[Math.floor(x/10)]+(x%10?' '+ones[x%10]:''):ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+under(x%100):'');n=Math.round(Math.max(0,n));if(n===0)return 'Zero';let s='';const c=Math.floor(n/1e7);n%=1e7;const l=Math.floor(n/1e5);n%=1e5;const t=Math.floor(n/1e3);n%=1e3;if(c)s+=under(c)+' Crore ';if(l)s+=under(l)+' Lakh ';if(t)s+=under(t)+' Thousand ';if(n)s+=under(n);return s.trim();}
const on=(s:any,k:string,def=true)=>s?.[k]===undefined?def:s[k]!==false;
function text(doc:any,v:any,x:number,y:number,w?:number,opts:any={}){const s=clean(v);if(!s)return 0;const lines=w?doc.splitTextToSize(s,w):[s];doc.text(lines,x,y,opts);return lines.length;}
function line(doc:any,label:string,value:any,x:number,y:number,w=75){if(!clean(value)&&num(value)===0)return y;doc.setFont('helvetica','normal');doc.setFontSize(8);doc.text(label,x,y);doc.setFont('helvetica','bold');doc.text(clean(value),x+w,y);return y+5;}

export async function GET(req:Request){
 try{
  const u=new URL(req.url);const mode = sessionMode(req);const id=Number(u.searchParams.get('id'));const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);if(!id)throw Error('Payment id is required');
  const d=db(mode,companyId);
  const p=d.prepare(`SELECT p.*,x.name party_name,x.address,x.contact,x.gst,x.pan,b.bank_name,b.account_number,b.ifsc,b.branch,a.account_name company_account_name FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=x.id ORDER BY is_primary DESC,id LIMIT 1) LEFT JOIN company_accounts a ON a.id=p.company_account_id WHERE p.id=?`).get(id) as any;
  if(!p)throw Error('Payment not found');
  const allocations=d.prepare(`SELECT a.amount allocation_amount,q.id purchase_id,q.sample_no,q.invoice_no,q.purchase_date,q.goods_description,q.bags_qty,q.gross_weight,q.net_weight,q.rate,q.discount_pct,q.gross_amount,q.unload_charge,q.freight,q.moisture,q.discount_amount,q.driver_rokdi,q.quality_deduct_amount,q.other_charges,q.net_payable, q.net_payable-COALESCE((SELECT SUM(a2.amount) FROM payment_allocations a2 JOIN payments p2 ON p2.id=a2.payment_id WHERE a2.purchase_id=q.id AND p2.status='POSTED'),0) outstanding_after FROM payment_allocations a JOIN purchases q ON q.id=a.purchase_id WHERE a.payment_id=? ORDER BY q.purchase_date,q.id`).all(id) as any[];
  const company=adminDb().prepare('SELECT id,name,code,address,city,state,email,gstin,pan,financial_year FROM companies WHERE id=?').get(companyId) as any;if(!company)throw Error('Company not found');
  const raw=d.prepare('SELECT payment_advice_settings FROM company_settings WHERE id=1').get() as any;let s:any={};try{s=JSON.parse(raw?.payment_advice_settings||'{}')}catch{}
  const doc=new jsPDF({unit:'mm',format:'a4'});const L=14,R=196,W=R-L;let y=14;
  doc.setTextColor(20,25,35);doc.setDrawColor(205,210,218);doc.setLineWidth(.3);
  doc.setFont('helvetica','bold');doc.setFontSize(16);doc.text(clean(company.name)||'SOLIVY',L,y);doc.setFontSize(8);doc.setFont('helvetica','normal');y+=5;
  const companyLines=[company.address,[company.city,company.state].filter(Boolean).join(', '),company.email&&`E-Mail: ${company.email}`,company.gstin&&`GSTIN: ${company.gstin}`,company.pan&&`PAN: ${company.pan}`].filter(Boolean).map(clean);
  for(const v of companyLines){doc.text(v,L,y);y+=3.8;}
  doc.setFont('helvetica','bold');doc.setFontSize(15);doc.text('PAYMENT ADVICE',R,17,{align:'right'});doc.setFontSize(8);doc.setFont('helvetica','normal');doc.text(`Payment No: ${clean(p.payment_no)}`,R,23,{align:'right'});if(on(s,'show_payment_date_top',false))doc.text(`Payment Date: ${dateText(p.payment_date)}`,R,28,{align:'right'});
  doc.line(L,34,R,34);y=42;
  doc.setFont('helvetica','bold');doc.setFontSize(8);doc.text('PAYMENT DETAILS',L,y);y+=6;
  const half=88;let leftY=y,rightY=y;
  leftY=line(doc,'Paid To',clean(p.party_name),L,leftY,38);leftY=line(doc,'Payment Mode',clean(p.mode),L,leftY,38);if(on(s,'show_utr'))leftY=line(doc,'UTR / Reference',clean(p.utr)||'—',L,leftY,38);
  rightY=line(doc,'Paid From',clean(p.company_account_name)||'—',106,rightY,38);if(clean(p.bank_name))rightY=line(doc,'Bank',p.bank_name,106,rightY,38);if(clean(p.broker_name)&&on(s,'show_broker'))rightY=line(doc,'Broker',p.broker_name,106,rightY,38);
  y=Math.max(leftY,rightY)+4;doc.line(L,y,R,y);y+=7;
  doc.setFont('helvetica','bold');doc.setFontSize(9);doc.text('SUPPLIER / PARTY',L,y);y+=5;doc.setFont('helvetica','normal');doc.setFontSize(8);
  const partyLines=[p.address&&on(s,'show_party_address')?p.address:'',p.contact&&on(s,'show_party_address')?`Contact: ${p.contact}`:'',p.gst&&on(s,'show_party_gst')?`GSTIN: ${p.gst}`:'',p.pan&&on(s,'show_party_pan')?`PAN: ${p.pan}`:''].filter(Boolean);
  for(const v of partyLines){text(doc,v,L,y,95);y+=4;}
  if(on(s,'show_bank_details')){doc.setFont('helvetica','bold');doc.text('BANK DETAILS',106,y-4);doc.setFont('helvetica','normal');let by=y;for(const [k,v] of [['Bank',p.bank_name],['A/C',p.account_number],['IFSC',p.ifsc],['Branch',p.branch]]){if(clean(v)){doc.text(`${k}: ${v}`,106,by);by+=4}}}
  y=Math.max(y+3,partyLines.length?y:50);doc.line(L,y,R,y);y+=7;

  const grossSettlement=num(p.amount);const tds=num(p.tds_amount);const displayedNet=on(s,'include_tds_in_net')?num(p.net_paid||grossSettlement-tds):grossSettlement;const allocatedTotal=allocations.reduce((a,r)=>a+num(r.allocation_amount),0);const unallocated=Math.max(0,Math.round(grossSettlement-allocatedTotal));
  if(on(s,'show_allocations')){
   doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text('BILL-WISE PAYMENT SETTLEMENT',L,y);y+=6;
   for(const r of allocations){
    if(y>255){doc.addPage();y=18;doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text('BILL-WISE PAYMENT SETTLEMENT — CONTINUED',L,y);y+=7;}
    doc.setFillColor(246,248,250);doc.roundedRect(L,y-4,W,7,1,1,'F');doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.text(`${clean(r.invoice_no)||clean(r.sample_no)}  •  Sample: ${clean(r.sample_no)||'—'}`,L+3,y);doc.text(money(r.allocation_amount),R-3,y,{align:'right'});y+=8;
    doc.setFont('helvetica','normal');doc.setFontSize(8);
    const info=[on(s,'show_purchase_date')&&`Purchase Date: ${dateText(r.purchase_date)}`,on(s,'show_description')&&r.goods_description&&`Description: ${r.goods_description}`].filter(Boolean);for(const v of info){text(doc,v,L+3,y,175);y+=4;}
    if(on(s,'show_net_weight')){text(doc,`Net Weight: ${num(r.net_weight).toLocaleString('en-IN',{maximumFractionDigits:2})} Kg`,L+3,y);y+=4.5;}if(on(s,'show_bags')){text(doc,`Bags / Packages: ${num(r.bags_qty).toLocaleString('en-IN',{maximumFractionDigits:2})}`,L+3,y);y+=4.5;}if(on(s,'show_rate')){text(doc,`Rate / Kg: INR ${num(r.rate).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`,L+3,y);y+=4.5;}
    if(on(s,'show_gross_amount',false)){doc.setFont('helvetica','bold');doc.text('Gross Amount',L+3,y);doc.setFont('helvetica','normal');doc.text(money(r.gross_amount),R-3,y,{align:'right'});y+=5;}
    const less:[string,any,string][]=[['Unload Charges',r.unload_charge,'show_unload'],['Freight',r.freight,'show_freight'],['Moisture',r.moisture,'show_moisture'],['Discount',r.discount_amount,'show_discount'],['Driver Rokdi',r.driver_rokdi,'show_driver_rokdi'],['Quality Deduct',r.quality_deduct_amount,'show_quality_deduct'],['Other Charges',r.other_charges,'show_other_charges']];
    for(const [label,val,key] of less){if(!on(s,key)||num(val)===0)continue;const displayLabel=label==='Discount'&&on(s,'show_discount_percent')?`Discount (${num(r.discount_pct).toFixed(2)}%)`:label;doc.text('Less:',L+3,y);doc.text(displayLabel,L+18,y);doc.text(`(-) ${money(val)}`,R-3,y,{align:'right'});y+=4.5;}
    if(on(s,'show_net_payable')){doc.setFont('helvetica','bold');doc.text('Net Payable',L+3,y);doc.text(money(r.net_payable),R-3,y,{align:'right'});y+=4.5;}
    if(on(s,'show_allocated',false)){doc.text('Payment Allocated',L+3,y);doc.text(money(r.allocation_amount),R-3,y,{align:'right'});y+=4.5;}
    if(on(s,'show_outstanding')){doc.text('Outstanding After Payment',L+3,y);doc.text(money(Math.max(0,r.outstanding_after)),R-3,y,{align:'right'});y+=4.5;}
    y+=4;doc.line(L,y,R,y);y+=6;
   }
  }
  if(y>250){doc.addPage();y=18;}
  doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text('SETTLEMENT SUMMARY',L,y);y+=7;
  const summary:[string,any][]=[];if(on(s,'show_gross_settlement',false))summary.push(['Gross Settlement',grossSettlement]);if(on(s,'show_tds'))summary.push([`TDS Deducted (${num(p.tds_rate)}%)`,tds]);summary.push(['Net Payment',displayedNet]);if(on(s,'show_allocated_total',false))summary.push(['Allocated to Bills',allocatedTotal]);if(on(s,'show_unallocated',false))summary.push(['Unallocated / Advance',unallocated]);
  for(const [label,val] of summary){doc.setFont('helvetica','normal');doc.text(label,L,y);doc.setFont('helvetica','bold');doc.text(money(val),R,y,{align:'right'});y+=5.5;}
  if(on(s,'show_amount_words')){y+=3;doc.setFont('helvetica','bold');doc.text('AMOUNT IN WORDS',L,y);doc.setFont('helvetica','normal');text(doc,`${words(displayedNet)} Rupees Only`,L,y+5,W);y+=13;}
  if(on(s,'show_payment_date_below_words',true)){doc.setFont('helvetica','normal');doc.text(`Payment Date: ${dateText(p.payment_date)}`,L,y);y+=5;}if(on(s,'show_utr_below_words',true)&&on(s,'show_utr')){doc.text(`UTR / Reference: ${clean(p.utr)||'—'}`,L,y);y+=5;}
  if(on(s,'show_notes')&&clean(p.notes)){doc.setFont('helvetica','bold');doc.text('NOTES',L,y);doc.setFont('helvetica','normal');text(doc,p.notes,L,y+5,W);y+=12;}
  doc.setDrawColor(215,219,225);doc.line(L,274,R,274);doc.setFont('helvetica','normal');doc.setFontSize(7);doc.text('System-generated payment advice. This document is not a bank confirmation or tax certificate.',L,280);doc.text(clean(company.name)||'SOLIVY',R,280,{align:'right'});
  const bytes=new Uint8Array(doc.output('arraybuffer'));return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Payment-Advice-${clean(p.payment_no)||id}.pdf"`}});
 }catch(e:any){return new Response(String(e?.message||'Unable to generate payment advice'),{status:500})}
}
