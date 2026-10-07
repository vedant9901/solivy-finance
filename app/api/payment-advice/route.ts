import {NextResponse} from 'next/server';
import {db,adminDb,Mode} from '../../../lib/db';
import {jsPDF} from 'jspdf';

const clean=(v:any)=>String(v??'').trim();
const money=(v:any)=>`₹${Math.round(Number(v)||0).toLocaleString('en-IN')}`;
const on=(s:any,k:string)=>s?.[k]!==false;
function dateText(v:any){const s=clean(v);if(!s)return '';const d=new Date(s+'T00:00:00');return Number.isNaN(d.getTime())?s:d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}).replace(/ /g,'-')}
function words(n:number){
 n=Math.round(Math.abs(n));
 const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
 const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
 const u=(x:number):string=>x<20?ones[x]:x<100?tens[Math.floor(x/10)]+(x%10?' '+ones[x%10]:''):ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+u(x%100):'');
 if(n===0)return 'Zero'; let s=''; const c=Math.floor(n/1e7);n%=1e7;const l=Math.floor(n/1e5);n%=1e5;const t=Math.floor(n/1e3);n%=1e3;if(c)s+=u(c)+' Crore ';if(l)s+=u(l)+' Lakh ';if(t)s+=u(t)+' Thousand ';if(n)s+=u(n);return s.trim();
}
function txt(doc:any,v:any,x:number,y:number,w?:number){const s=clean(v);if(!s)return false;doc.text(w?doc.splitTextToSize(s,w):s,x,y);return true}

export async function GET(req:Request){
 try{
  const u=new URL(req.url);const mode=(u.searchParams.get('mode')||'LIVE') as Mode;const id=Number(u.searchParams.get('id'));
  const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||0);
  if(!id)throw Error('Payment id is required');if(!companyId)throw Error('Current company is required');
  const d=await db(mode,companyId);
  const p=await d.prepare(`SELECT p.*,x.name party_name,x.address,x.contact,x.gst,x.pan,b.bank_name,b.account_holder,b.account_number,b.ifsc,b.branch
    FROM payments p JOIN parties x ON x.id=p.party_id
    LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=x.id ORDER BY is_primary DESC,id LIMIT 1)
    WHERE p.id=?`).get(id) as any;
  if(!p)throw Error('Payment not found');
  const allocations=await d.prepare(`SELECT q.sample_no,q.invoice_no,q.purchase_date,a.amount FROM payment_allocations a JOIN purchases q ON q.id=a.purchase_id WHERE a.payment_id=? ORDER BY q.purchase_date,q.id`).all(id) as any[];
  const admin=await adminDb();
  const master=await admin.prepare('SELECT id,name,code,address,city,state,email,gstin,pan FROM companies WHERE id=?').get(companyId) as any;
  if(!master)throw Error('Company not found');
  const settingsRow=await d.prepare('SELECT payment_advice_settings FROM company_settings WHERE id=1').get() as any;
  let s:any={};try{s=JSON.parse(settingsRow?.payment_advice_settings||'{}')}catch{}
  const companyName=clean(master.name)||clean(master.code)||'Company';

  const doc=new jsPDF({unit:'mm',format:'a4'});const L=15,R=195,W=180;let y=18;
  doc.setDrawColor(210,214,220);doc.setTextColor(25,25,25);doc.setLineWidth(.35);
  doc.setFont('helvetica','bold');doc.setFontSize(18);txt(doc,companyName,L,y);y+=7;
  const companyLines=[master.address,master.city,master.state,master.email,master.gstin?`GSTIN : ${master.gstin}`:''].map(clean).filter(Boolean);
  doc.setFont('helvetica','normal');doc.setFontSize(7.5);for(const line of companyLines){txt(doc,line,L,y,120);y+=3.8;}
  doc.setFont('helvetica','bold');doc.setFontSize(13);doc.text('PAYMENT ADVICE',R,22,{align:'right'});
  doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.text(`Payment No : ${clean(p.payment_no)}`,R,28,{align:'right'});doc.text(`Date : ${dateText(p.payment_date)}`,R,32,{align:'right'});
  y=Math.max(y,38);doc.line(L,y,R,y);y+=8;

  // Only render populated payment metadata. Empty labels are intentionally omitted.
  const meta:[string,string][]=[];
  if(clean(p.mode))meta.push(['Payment Mode',clean(p.mode)]);
  if(on(s,'show_utr')&&clean(p.utr))meta.push(['UTR / Reference',clean(p.utr)]);
  if(clean(p.bank_name))meta.push(['Payment Bank',clean(p.bank_name)]);
  if(clean(p.reference_no))meta.push(['Reference No.',clean(p.reference_no)]);
  if(meta.length){doc.setFont('helvetica','bold');doc.setFontSize(8);let mx=L;let my=y;for(const [k,v] of meta){txt(doc,k,mx,my);doc.setFont('helvetica','normal');txt(doc,v,mx,my+5,78);mx+=90;if(mx>150){mx=L;my+=15;}}y=Math.max(y,my+11);}

  const boxY=y;doc.roundedRect(L,boxY,W,42,2,2);doc.setFont('helvetica','bold');doc.setFontSize(8);txt(doc,'PAID TO',L+5,boxY+7);doc.setFontSize(12);txt(doc,p.party_name,L+5,boxY+14,100);doc.setFont('helvetica','normal');doc.setFontSize(8);let py=boxY+20;
  for(const line of [on(s,'show_party_address')?p.address:'',p.contact?`Contact : ${p.contact}`:'',on(s,'show_party_gst')&&p.gst?`GSTIN : ${p.gst}`:'',on(s,'show_party_pan')&&p.pan?`PAN : ${p.pan}`:''].map(clean).filter(Boolean)){txt(doc,line,L+5,py,105);py+=4;}
  const bank=[on(s,'show_bank_details')&&p.bank_name?`Bank : ${p.bank_name}`:'',on(s,'show_bank_details')&&p.account_holder?`A/c Holder : ${p.account_holder}`:'',on(s,'show_bank_details')&&p.account_number?`A/c No. : ${p.account_number}`:'',on(s,'show_bank_details')&&p.ifsc?`IFSC : ${p.ifsc}`:''].map(clean).filter(Boolean);
  if(bank.length){doc.setFont('helvetica','bold');txt(doc,'SUPPLIER BANK',125,boxY+7);doc.setFont('helvetica','normal');let by=boxY+14;for(const line of bank){txt(doc,line,125,by,65);by+=4;}}
  y=boxY+51;

  if(on(s,'show_allocations')&&allocations.length){doc.setFont('helvetica','bold');doc.setFontSize(8);txt(doc,'BILL ALLOCATIONS',L,y);y+=5;doc.setFillColor(244,246,248);doc.rect(L,y-4,W,7,'F');txt(doc,'Invoice / Sample',L+3,y);doc.text('Date',125,y);doc.text('Amount',R-3,y,{align:'right'});y+=7;doc.setFont('helvetica','normal');for(const a of allocations){txt(doc,`${clean(a.invoice_no)||clean(a.sample_no)}${clean(a.sample_no)&&clean(a.invoice_no)?` / ${clean(a.sample_no)}`:''}`,L+3,y,105);txt(doc,dateText(a.purchase_date),125,y);doc.text(money(a.amount),R-3,y,{align:'right'});y+=6;}y+=4;}

  const gross=Math.round(Number(p.amount)||0);const tds=Math.round(Number(p.tds_amount)||0);const net=on(s,'include_tds_in_net')?Math.max(0,Math.round(Number(p.net_paid??(gross-tds)))):gross;
  doc.line(110,y,R,y);y+=7;doc.setFont('helvetica','normal');doc.setFontSize(8);txt(doc,'Gross Settlement',120,y);doc.text(money(gross),R,y,{align:'right'});y+=6;
  if(on(s,'show_tds')&&tds>0){txt(doc,`TDS${Number(p.tds_rate||0)?` (${Number(p.tds_rate)}%)`:''}`,120,y);doc.text(`- ${money(tds)}`,R,y,{align:'right'});y+=6;}
  doc.setFont('helvetica','bold');doc.setFontSize(11);txt(doc,'NET BANK PAYMENT',120,y);doc.text(money(net),R,y,{align:'right'});y+=11;
  if(on(s,'show_amount_words')){doc.setFont('helvetica','bold');doc.setFontSize(8);txt(doc,'Amount in Words',L,y);doc.setFont('helvetica','normal');txt(doc,`${words(net)} Rupees Only`,L,y+5,180);y+=15;}
  if(on(s,'show_broker')&&clean(p.broker_name)){doc.setFont('helvetica','bold');txt(doc,'Broker',L,y);doc.setFont('helvetica','normal');txt(doc,`${clean(p.broker_name)}${clean(p.broker_email)?` • ${clean(p.broker_email)}`:''}`,L,y+5,180);y+=13;}
  if(on(s,'show_notes')&&clean(p.notes)){doc.setFont('helvetica','bold');txt(doc,'Notes',L,y);doc.setFont('helvetica','normal');txt(doc,p.notes,L,y+5,180);y+=14;}
  doc.setFontSize(7.2);doc.setTextColor(90,90,90);doc.text('System-generated payment advice. This document is not a bank confirmation or tax certificate.',L,276);doc.text(companyName,R,276,{align:'right'});
  const bytes=new Uint8Array(doc.output('arraybuffer'));const safe=(clean(p.payment_no)||`payment-${id}`).replace(/[^A-Za-z0-9_-]/g,'_');
  return new Response(bytes,{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','Content-Disposition':`attachment; filename="Payment-Advice-${safe}.pdf"`}});
 }catch(e:any){return NextResponse.json({error:e?.message||'Unable to generate payment advice'},{status:500});}
}
