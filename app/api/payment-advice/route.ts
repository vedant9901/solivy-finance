import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
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

async function __bridge_GET(req:Request){
 try{
  const u=new URL(req.url);const mode = sessionMode(req);const id=Number(u.searchParams.get('id'));const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);if(!id)throw Error('Payment id is required');
  const d=db(mode,companyId);
  const p=d.prepare(`SELECT p.*,x.name party_name,x.address,x.contact,x.gst,x.pan,b.bank_name,b.account_number,b.ifsc,b.branch,a.account_name company_account_name FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=x.id ORDER BY is_primary DESC,id LIMIT 1) LEFT JOIN company_accounts a ON a.id=p.company_account_id WHERE p.id=?`).get(id) as any;
  if(!p)throw Error('Payment not found');
  if(String(p.status||'').toUpperCase()!=='POSTED')throw Error('Payment advice is unavailable for reversed or non-posted payments.');
  const allocations=d.prepare(`SELECT a.amount allocation_amount,q.id purchase_id,q.sample_no,q.invoice_no,q.purchase_date,q.notes,q.goods_description,q.bags_qty,q.gross_weight,q.net_weight,q.rate,q.discount_pct,q.gross_amount,q.unload_charge,q.freight,q.moisture,q.discount_amount,q.driver_rokdi,q.quality_deduct_amount,q.other_charges,q.net_payable, q.net_payable-COALESCE((SELECT SUM(a2.amount) FROM payment_allocations a2 JOIN payments p2 ON p2.id=a2.payment_id WHERE a2.purchase_id=q.id AND p2.status='POSTED'),0) outstanding_after FROM payment_allocations a JOIN purchases q ON q.id=a.purchase_id WHERE a.payment_id=? ORDER BY q.purchase_date,q.id`).all(id) as any[];
  const company=adminDb().prepare('SELECT id,name,code,address,city,state,email,gstin,pan,financial_year FROM companies WHERE id=?').get(companyId) as any;if(!company)throw Error('Company not found');
  const raw=d.prepare('SELECT payment_advice_settings FROM company_settings WHERE id=1').get() as any;let s:any={};try{s=JSON.parse(raw?.payment_advice_settings||'{}')}catch{}
  const doc=new jsPDF({unit:'mm',format:'a4'});const themePalette:Record<string,[number,number,number]>={teal:[15,118,110],blue:[37,99,235],violet:[124,58,237],emerald:[5,150,105],amber:[217,119,6],rose:[225,29,72]};
  const L=14,R=196,W=R-L,PAGE_BOTTOM=282;
  let y=14;
  const ink: [number,number,number]=[28,39,56], muted: [number,number,number]=[93,105,120], border: [number,number,number]=[214,220,228], pale: [number,number,number]=[245,248,251], accent: [number,number,number]=themePalette[new URL(req.url).searchParams.get('theme')||'teal']||[15,118,110];
  doc.setTextColor(...ink);doc.setDrawColor(...border);doc.setLineWidth(.25);
  const moneyRight=(v:any,x=R-4,yy=y)=>{doc.setFont('helvetica','bold');doc.text(money(v),x,yy,{align:'right'});};
  const rule=(yy:number)=>{doc.setDrawColor(...border);doc.line(L,yy,R,yy);};
  const ensure=(need=12)=>{if(y+need>PAGE_BOTTOM){doc.addPage();y=15;doc.setTextColor(...ink);doc.setDrawColor(...border);doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text('PAYMENT ADVICE — CONTINUED',L,y);y+=7;rule(y);y+=5;}};
  const section=(title:string)=>{ensure(10);doc.setFillColor(...pale);doc.roundedRect(L,y-4,W,7,1.2,1.2,'F');doc.setTextColor(...accent);doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.text(title.toUpperCase(),L+3,y+.5);doc.setTextColor(...ink);y+=7;};
  const row=(label:string,value:any,x:number,yy:number,width:number)=>{if(!clean(value))return;doc.setFont('helvetica','normal');doc.setFontSize(7.8);doc.setTextColor(...muted);doc.text(label,x,yy);doc.setFont('helvetica','bold');doc.setTextColor(...ink);const val=clean(value);const lines=doc.splitTextToSize(val,width-29);doc.text(lines,x+29,yy);};

  // Compact invoice-style header; only non-empty company details are printed.
  doc.setFillColor(255,255,255);doc.setDrawColor(...border);doc.roundedRect(L,10,W,25,1.5,1.5,'S');
  doc.setFont('helvetica','bold');doc.setFontSize(13);doc.setTextColor(...ink);doc.text(clean(company.name)||'SOLIVY',L+4,17);
  doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.setTextColor(...muted);
  let cy=21;const companyLines=[company.address,[company.city,company.state].filter(Boolean).join(', '),company.email&&`E-mail: ${company.email}`,company.gstin&&`GSTIN: ${company.gstin}`,company.pan&&`PAN: ${company.pan}`].filter(v=>clean(v));
  for(const v of companyLines.slice(0,3)){const lines=doc.splitTextToSize(clean(v),95);doc.text(lines,L+4,cy);cy+=Math.min(lines.length,2)*3.3;}
  doc.setFillColor(...accent);doc.roundedRect(128,12,64,18,1.5,1.5,'F');doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(11);doc.text('PAYMENT ADVICE',160,19,{align:'center'});doc.setFontSize(8);doc.text(`Payment No. ${clean(p.payment_no)||id}`,160,25,{align:'center'});
  doc.setTextColor(...ink);y=40;
  const metaDate=on(s,'show_payment_date_top',true)&&clean(p.payment_date)?dateText(p.payment_date):'';
  if(metaDate){doc.setFont('helvetica','normal');doc.setFontSize(8);doc.text(`Payment Date: ${metaDate}`,R,y,{align:'right'});y+=4;}

  section('Payment details');
  const detailTop=y, boxH=24;
  doc.setDrawColor(...border);doc.roundedRect(L,detailTop-3,88,boxH,1.2,1.2,'S');doc.roundedRect(106,detailTop-3,90,boxH,1.2,1.2,'S');
  let ly=detailTop+3,ry=detailTop+3;
  const detail=(label:string,value:any,x:number,yy:number)=>{if(!clean(value))return yy;row(label,value,x,yy,82);return yy+5;};
  ly=detail('Paid To',p.party_name,L+3,ly);ly=detail('Payment Mode',p.mode,L+3,ly);if(on(s,'show_utr'))ly=detail('UTR / Ref.',p.utr,L+3,ly);
  ry=detail('Paid From',p.company_account_name,109,ry);ry=detail('Bank',p.bank_name,109,ry);if(clean(p.broker_name)&&on(s,'show_broker'))ry=detail('Broker',p.broker_name,109,ry);
  y=detailTop+boxH+3;

  // Supplier and beneficiary bank information sit side-by-side and collapse when empty.
  const partyInfo=[p.address&&on(s,'show_party_address')?['Address',p.address]:null,p.contact&&on(s,'show_party_address')?['Contact',p.contact]:null,p.gst&&on(s,'show_party_gst')?['GSTIN',p.gst]:null,p.pan&&on(s,'show_party_pan')?['PAN',p.pan]:null].filter(Boolean) as [string,any][];
  const bankInfo=on(s,'show_bank_details')?([['Bank',p.bank_name],['A/C',p.account_number],['IFSC',p.ifsc],['Branch',p.branch]].filter((x:any)=>clean(x[1])) as [string,any][]):[];
  if(partyInfo.length||bankInfo.length){section('Supplier / party & bank details');const top=y;const leftX=L+3,rightX=108;let py=top+1,by=top+1;
    if(partyInfo.length){doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.text(clean(p.party_name),leftX,py);py+=4;for(const [k,v] of partyInfo){doc.setFont('helvetica','normal');doc.setFontSize(7.3);doc.setTextColor(...muted);doc.text(`${k}:`,leftX,py);doc.setTextColor(...ink);const lines=doc.splitTextToSize(clean(v),72);doc.text(lines,leftX+19,py);py+=Math.max(3.5,lines.length*3.5);}}
    if(bankInfo.length){doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.text('BENEFICIARY BANK',rightX,by);by+=4;for(const [k,v] of bankInfo){doc.setFont('helvetica','normal');doc.setFontSize(7.3);doc.setTextColor(...muted);doc.text(`${k}:`,rightX,by);doc.setTextColor(...ink);doc.text(doc.splitTextToSize(clean(v),70),rightX+18,by);by+=3.7;}}
    y=Math.max(py,by)+3;rule(y);y+=5;
  }

  const grossSettlement=num(p.amount),tds=num(p.tds_amount),displayedNet=on(s,'include_tds_in_net')?num(p.net_paid||grossSettlement-tds):grossSettlement;
  const allocatedTotal=allocations.reduce((a,r)=>a+num(r.allocation_amount),0),unallocated=Math.max(0,Math.round(grossSettlement-allocatedTotal));
  if(on(s,'show_allocations')&&allocations.length){section('Bill-wise payment settlement');
    for(const r of allocations){
      const less:[string,any,string][]=[['Unload Charges',r.unload_charge,'show_unload'],['Freight',r.freight,'show_freight'],['Moisture',r.moisture,'show_moisture'],['Discount',r.discount_amount,'show_discount'],['Driver Rokdi',r.driver_rokdi,'show_driver_rokdi'],['Quality Deduct',r.quality_deduct_amount,'show_quality_deduct'],['Other Charges',r.other_charges,'show_other_charges']].filter(([_,v,k])=>on(s,k as string)&&num(v)!==0) as [string,any,string][];
      const infoRows=(on(s,'show_description')&&clean(r.goods_description)?1:0)+(on(s,'show_purchase_date')&&clean(r.purchase_date)?1:0)+(on(s,'show_net_weight')?1:0)+(on(s,'show_bags')?1:0)+(on(s,'show_rate')?1:0)+(on(s,'show_gross_amount',false)?1:0)+less.length+(on(s,'show_net_payable')?1:0)+(on(s,'show_allocated',false)?1:0)+(on(s,'show_outstanding')?1:0)+(on(s,'show_notes')&&clean(r.notes)?1:0);
      ensure(Math.min(42,12+infoRows*4));
      const cardTop=y;doc.setDrawColor(...border);doc.roundedRect(L,cardTop-3,W,Math.max(19,16+infoRows*4),1.2,1.2,'S');
      doc.setFillColor(...pale);doc.roundedRect(L,cardTop-3,W,7,1.2,1.2,'F');doc.setFont('helvetica','bold');doc.setFontSize(8.2);doc.setTextColor(...ink);
      const invoice=clean(r.invoice_no);const sample=clean(r.sample_no);const heading=[invoice?`Invoice ${invoice}`:'',sample?`Sample ${sample}`:''].filter(Boolean).join('  •  ')||`Purchase ${r.purchase_id}`;doc.text(heading,L+3,cardTop+1);moneyRight(r.allocation_amount,R-3,cardTop+1);y=cardTop+8;
      doc.setFont('helvetica','normal');doc.setFontSize(7.4);doc.setTextColor(...muted);
      const details:[boolean,string,string][]=[ [on(s,'show_purchase_date')&&!!clean(r.purchase_date),'Date',dateText(r.purchase_date)], [on(s,'show_description')&&!!clean(r.goods_description),'Description',clean(r.goods_description)], [on(s,'show_net_weight'),'Net Weight',`${num(r.net_weight).toLocaleString('en-IN',{maximumFractionDigits:2})} Kg`], [on(s,'show_bags'),'Bags / Packages',num(r.bags_qty).toLocaleString('en-IN',{maximumFractionDigits:2})], [on(s,'show_rate'),'Rate / Kg',`INR ${num(r.rate).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`] ];
      for(const [show,label,value] of details){if(!show||!clean(value))continue;doc.setTextColor(...muted);doc.text(label,L+3,y);doc.setTextColor(...ink);doc.text(doc.splitTextToSize(value,100),L+35,y);y+=4;} if(on(s,'show_notes')&&clean(r.notes)){doc.setTextColor(...muted);doc.text('Purchase Note',L+3,y);doc.setTextColor(...ink);doc.text(doc.splitTextToSize(clean(r.notes),100),L+35,y);y+=4;}
      if(on(s,'show_gross_amount',false)){doc.setTextColor(...muted);doc.text('Gross Amount',L+3,y);moneyRight(r.gross_amount,R-3,y);y+=4;}
      for(const [label,val] of less){const shown=label==='Discount'&&on(s,'show_discount_percent')?`Discount (${num(r.discount_pct).toFixed(2)}%)`:label;doc.setTextColor(...muted);doc.text(`Less: ${shown}`,L+3,y);doc.setTextColor(...ink);doc.text(`(-) ${money(val)}`,R-3,y,{align:'right'});y+=4;}
      if(on(s,'show_net_payable')){doc.setFont('helvetica','bold');doc.setTextColor(...ink);doc.text('Net Payable',L+3,y);moneyRight(r.net_payable,R-3,y);y+=4;}
      if(on(s,'show_allocated',false)){doc.setFont('helvetica','normal');doc.text('Payment Allocated',L+3,y);moneyRight(r.allocation_amount,R-3,y);y+=4;}
      if(on(s,'show_outstanding')){doc.text('Outstanding After Payment',L+3,y);moneyRight(Math.max(0,r.outstanding_after),R-3,y);y+=4;}
      y+=3;doc.setDrawColor(...border);doc.line(L+3,y,R-3,y);y+=4;
    }
  }

  ensure(35);section('Settlement summary');
  const summary:[string,any][]=[];if(on(s,'show_gross_settlement',false))summary.push(['Gross Settlement',grossSettlement]);if(on(s,'show_tds'))summary.push([`TDS Deducted (${num(p.tds_rate)}%)`,tds]);summary.push(['Net Payment',displayedNet]);if(on(s,'show_allocated_total',false))summary.push(['Allocated to Bills',allocatedTotal]);if(on(s,'show_unallocated',false))summary.push(['Unallocated / Advance',unallocated]);
  for(const [label,val] of summary){ensure(6);doc.setFont('helvetica',label==='Net Payment'?'bold':'normal');doc.setFontSize(label==='Net Payment'?9:8);doc.setTextColor(...ink);doc.text(label,L+3,y);moneyRight(val,R-3,y);y+=5;}
  if(on(s,'show_amount_words')){y+=2;ensure(10);doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.setTextColor(...muted);doc.text('AMOUNT IN WORDS',L,y);y+=4;doc.setFont('helvetica','normal');doc.setTextColor(...ink);text(doc,`${words(displayedNet)} Rupees Only`,L,y,W);y+=5;}
  if(on(s,'show_payment_date_below_words',true)&&clean(p.payment_date)){ensure(5);doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.text(`Payment Date: ${dateText(p.payment_date)}`,L,y);y+=4;}
  if(on(s,'show_utr_below_words',true)&&on(s,'show_utr')&&clean(p.utr)){ensure(5);doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.text(`UTR / Reference: ${clean(p.utr)}`,L,y);y+=4;}
  if(on(s,'show_notes')&&clean(p.notes)){ensure(10);y+=2;doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.text('NOTES',L,y);y+=4;doc.setFont('helvetica','normal');text(doc,p.notes,L,y,W);y+=5;}
  // Content-relative footer; never reserve a large fixed blank area at the bottom.
  ensure(12);y+=2;rule(y);y+=4;doc.setFont('helvetica','normal');doc.setFontSize(6.5);doc.setTextColor(...muted);doc.text('System-generated payment advice. This document is not a bank confirmation or tax certificate.',L,y);doc.setFont('helvetica','bold');doc.setTextColor(...ink);doc.text(clean(company.name)||'SOLIVY',R,y,{align:'right'});
  const bytes=new Uint8Array(doc.output('arraybuffer'));return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Payment-Advice-${clean(p.payment_no)||id}.pdf"`}});
 }catch(e:any){return new Response(String(e?.message||'Unable to generate payment advice'),{status:500})}
}

export const runtime = 'nodejs';

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
