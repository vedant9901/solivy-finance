import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import { NextResponse } from 'next/server';
import { db, adminDb, Mode } from '../../../lib/db';
import jsPDF from 'jspdf';
import { billDeductions, buildBillModel } from '../../../lib/documents/bill-model';
import { renderBillTemplate, isTemplate } from '../../../lib/documents/templates';
import { resolveDocumentPreference, sanitizeTheme } from '../../../lib/documents/preferences';

const clean=(v:any)=>String(v??'').trim();
const money=(v:any)=>Number(v||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=(v:any)=>Math.round(Number(v||0));
const kg=(v:any)=>num(v).toLocaleString('en-IN');
const dateText=(v:any)=>{const s=clean(v);if(!s)return '';const iso=s.match(/^(\d{4}-\d{2}-\d{2})/);if(iso){const [y,m,d]=iso[1].split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));if(!Number.isNaN(dt.getTime()))return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).replace(/ /g,'-');}const d=new Date(s);if(Number.isNaN(d.getTime()))return s;return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}).replace(/ /g,'-')};
function words(n:number){
  n=Math.round(Math.abs(n));
  const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  const under=(x:number):string=>x<20?ones[x]:x<100?tens[Math.floor(x/10)]+(x%10?' '+ones[x%10]:''):ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+under(x%100):'');
  if(n===0)return 'Zero';
  let s='';const crore=Math.floor(n/1e7);n%=1e7;const lakh=Math.floor(n/1e5);n%=1e5;const thousand=Math.floor(n/1e3);n%=1e3;
  if(crore)s+=under(crore)+' Crore ';if(lakh)s+=under(lakh)+' Lakh ';if(thousand)s+=under(thousand)+' Thousand ';if(n)s+=under(n);return s.trim();
}
function bool(settings:any,key:string,def=true){return settings?.[key]===undefined?def:!!settings[key]}
function text(doc:any,value:any,x:number,y:number,maxWidth?:number,opts:any={}){const v=clean(value);if(!v)return false;doc.text(maxWidth?doc.splitTextToSize(v,maxWidth):v,x,y,opts);return true}
function right(doc:any,value:any,x:number,y:number){const v=clean(value);if(!v)return false;doc.text(v,x,y,{align:'right'});return true}

async function __bridge_GET(req:Request){
 try{
  const u=new URL(req.url);
  const mode = sessionMode(req);
  const id=Number(u.searchParams.get('id'));
  const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);
  const billType=u.searchParams.get('bill_type')||'purchase';
  const thirdPartyId=Number(u.searchParams.get('third_party_id')||0);
  if(!id)throw Error('Purchase id is required');

  const d=db(mode,companyId);
  const row=d.prepare(`SELECT p.*,x.name party_name,x.address,x.contact,x.gst,x.pan,br.name broker_party_name,br.contact broker_contact,br.email broker_email,b.bank_name,b.account_holder,b.account_number,b.ifsc,b.branch
    FROM purchases p JOIN parties x ON x.id=p.party_id LEFT JOIN parties br ON br.id=p.broker_party_id
    LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=x.id ORDER BY is_primary DESC,id LIMIT 1)
    WHERE p.id=?`).get(id) as any;
  if(!row)throw Error('Purchase not found');
  if(String(row.status||'').toUpperCase()==='REVERSED') throw Error('PDF is unavailable for reversed purchase/sample entries.');

  let toParty={name:row.party_name,address:row.address,contact:row.contact,gst:row.gst,pan:row.pan};
  if(billType==='third-party'){
    if(!thirdPartyId)throw Error('Third party is required');
    const tp=d.prepare('SELECT name,address,contact,gst,pan FROM third_parties WHERE id=? AND active=1').get(thirdPartyId) as any;
    if(!tp)throw Error('Third party not found');
    toParty=tp;
  }

  const company=adminDb().prepare('SELECT id,name,code,address,city,state,email,gstin,pan,financial_year FROM companies WHERE id=?').get(companyId) as any;
  if(!company)throw Error('Company not found');
  const companyBank=d.prepare('SELECT * FROM company_accounts WHERE active=1 ORDER BY id LIMIT 1').get() as any;
  const raw=d.prepare('SELECT commercial_bill_settings,third_party_bill_settings FROM company_settings WHERE id=1').get() as any;
  let s:any={};try{s=JSON.parse((billType==='third-party'?raw?.third_party_bill_settings:raw?.commercial_bill_settings)||'{}')}catch{}
  // Support legacy setting names used by earlier client builds.
  if (billType === 'third-party' && s.show_sample_date_together === undefined) { const v = s.combine_sample_date ?? s.combine_sample_no_date ?? s.show_sample_no_date_together; if (v !== undefined) s.show_sample_date_together = v; }

  const legacyCombined = s.combine_sample_date ?? s.combine_sample_no_date ?? s.show_sample_no_date_together;
  const combineSampleDate = s.show_sample_date_together !== undefined
    ? !!s.show_sample_date_together
    : (legacyCombined !== undefined ? !!legacyCombined : billType === 'third-party');

  const kind=billType==='third-party'?'third-party':'commercial';
  const pref=resolveDocumentPreference(d,String(req.headers.get('x-aksh-user')||''),kind);
  const requestedTemplate=u.searchParams.get('template');
  const template=requestedTemplate&&isTemplate(requestedTemplate)?requestedTemplate:pref.template_id;
  const disposition=u.searchParams.get('preview')==='1'?'inline':'attachment';
  if(template!=='classic'){
    const model=buildBillModel({row,company,companyBank,toParty,settings:s,kind});
    // Unsaved theme choices may be previewed (never applied to downloads).
    const theme=disposition==='inline'?{...pref.theme,...sanitizeTheme({accent:u.searchParams.get('accent'),font:u.searchParams.get('font'),density:u.searchParams.get('density')})}:pref.theme;
    const pdf=renderBillTemplate(model,template as any,theme);
    return new Response(new Uint8Array(pdf),{headers:{'Content-Type':'application/pdf','Content-Disposition':`${disposition}; filename="Commercial-Bill-${model.fileBase}.pdf"`,'Cache-Control':'no-store','X-Bill-Total':String(model.total),'X-Bill-Template':template}});
  }
  const doc=new jsPDF({unit:'mm',format:'a4'});
  const pageW=210,pageH=297,L=11.5,R=198.5,W=R-L;
  const black=[25,25,25] as const;
  doc.setTextColor(...black);doc.setDrawColor(...black);doc.setLineWidth(.28);
  doc.setFont('helvetica','bold');doc.setFontSize(12);doc.text('INVOICE',105,9,{align:'center'});
  // Print the transaction date only when enabled; combined Sample No. / Date uses the metadata row.
  // Prefer the actual purchase date; created_at is only a last-resort fallback for legacy rows with no date.
  const headerDate=dateText(row.purchase_date)||dateText(row.created_at);
  if(headerDate && bool(s,'show_date',true) && !combineSampleDate){doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.text(`Date: ${headerDate}`,R,9,{align:'right'});}

  // This follows the supplied one-page invoice: company + invoice meta, buyer, goods grid, deductions, total, words, declaration and bank block.
  const top=14.5, metaX=137, buyerTop=58, buyerBottom=88, metaBottom=58;
  const leftRight=metaX;
  doc.rect(L,top,leftRight-L,metaBottom-top);
  doc.rect(L,buyerTop,leftRight-L,buyerBottom-buyerTop);
  doc.rect(metaX,buyerTop,R-metaX,buyerBottom-buyerTop);

  // Company block — no red/green colouring: those colours in the supplied image are annotation, not document styling.
  let y=top+7;
  if(bool(s,'show_company_name',true)){doc.setFont('helvetica','bold');doc.setFontSize(11);text(doc,company.name||'SOLIVY',L+3.5,y);y+=5;}
  doc.setFont('helvetica','normal');doc.setFontSize(7.8);
  if(bool(s,'show_company_address')){for(const line of [company.address,company.city,company.state].map(clean).filter(Boolean)){text(doc,line,L+3.5,y,118);y+=4;}}
  if(bool(s,'show_company_gst')&&clean(company.gstin)){text(doc,`GSTIN : ${company.gstin}`,L+3.5,y);y+=4;}
  if(bool(s,'show_company_pan')&&clean(company.pan)){text(doc,`PAN : ${company.pan}`,L+3.5,y);y+=4;}
  if(bool(s,'show_company_email')&&clean(company.email)){text(doc,`E-Mail : ${company.email}`,L+3.5,y);}

  // Right metadata grid: retain the source layout but omit empty values.
  // For a 3rd Party Bill, use the invoice number entered in Purchase Entry exactly;
  // do not silently substitute the internal sample number as an invoice number.
  const purchaseInvoiceNo=clean(row.invoice_no);
  const billInvoiceNo=purchaseInvoiceNo;
  const purchaseDate=dateText(row.purchase_date)||dateText(row.created_at);
  // Combined display is governed by the same saved setting for both document types.
  // The combined option is authoritative: it must include the sample number even if
  // the separate Sample No. display checkbox is off.
  const sampleNo=(combineSampleDate||bool(s,'show_sample_no'))?clean(row.sample_no):'';
  // Build only meaningful metadata. Put the purchase date in the first metadata row
  // beside Invoice No when the combined Sample No./Date option is off. When enabled,
  // print Sample No. / Date together, without duplicating the date elsewhere.
  type MetaPair=[string,string];
  const pairs:MetaPair[]=[];
  if(bool(s,'show_bill_number',true)&&Number(row.bill_number||row.id)>0)pairs.push(['Bill No.',String(row.bill_number||row.id)]);
  if(bool(s,'show_invoice_no')&&billInvoiceNo)pairs.push(['Invoice No.',billInvoiceNo]);
  if(combineSampleDate){
    const sampleAndDate=[sampleNo,bool(s,'show_date',true)?purchaseDate:''].filter(Boolean).join(' / ');
    if(sampleAndDate)pairs.push(['Sample No. / Date',sampleAndDate]);
    if(bool(s,'show_truck_number')&&clean(row.truck_number))pairs.push(['Truck No.',clean(row.truck_number)]);
  } else {
    if(bool(s,'show_date',true)&&purchaseDate)pairs.push(['Dated',purchaseDate]);
    if(sampleNo)pairs.push(['Sample No.',sampleNo]);
    if(bool(s,'show_truck_number')&&clean(row.truck_number))pairs.push(['Truck No.',clean(row.truck_number)]);
  }
  if(bool(s,'show_reference_no')&&(clean(row.reference_no)||clean(row.reference_number)||clean(row.reference)) )pairs.push(['Reference No.',clean(row.reference_no||row.reference_number||row.reference)]);
  if(bool(s,'show_buyer_order_no')&&(clean(row.buyer_order_no)||clean(row.order_no)||clean(row.purchase_order_no)))pairs.push(["Buyer's Order No.",clean(row.buyer_order_no||row.order_no||row.purchase_order_no)]);
  if(bool(s,'show_other_references')&&(clean(row.other_references)||clean(row.other_reference)))pairs.push(['Other References',clean(row.other_references||row.other_reference)]);
  if(bool(s,'show_delivery_terms')&&(clean(row.delivery_terms)||clean(row.terms_of_delivery)))pairs.push(['Terms of Delivery',clean(row.delivery_terms||row.terms_of_delivery)]);
  if(bool(s,'show_payment_terms')&&Number(row.payment_due_days)>0)pairs.push(['Mode/Terms of Payment',`Due after ${Number(row.payment_due_days)} days`]);
  // Print optional metadata only when both its setting is enabled and the record contains a value.
  // Keep one metadata pair per row. The previous two-pair layout calculated
  // split columns beyond the right page edge (metaX + 102 mm > R), so the
  // second pair such as Sample No. / Date was clipped and never visible.
  const metaRows:MetaPair[][]=pairs.map(pair=>[pair]);
  const rh=metaRows.length?Math.min(8.7,(metaBottom-top)/metaRows.length):0;
  const metaActualBottom=top+metaRows.length*rh;
  if(metaRows.length){
    doc.rect(metaX,top,R-metaX,metaActualBottom-top);
    metaRows.forEach((r,i)=>{
      const rowY=top+i*rh;
      if(i>0)doc.line(metaX,rowY,R,rowY);
      const split1=metaX+34;
      doc.line(split1,rowY,split1,rowY+rh);
      const yy=rowY+Math.min(4.7,rh-1.2);
      doc.setFontSize(7.2);
      doc.setFont('helvetica','bold');text(doc,r[0][0],metaX+2,yy,30);
      doc.setFont('helvetica','normal');text(doc,r[0][1],split1+2,yy,R-split1-4);
    });
  }

  // Buyer block.
  if(bool(s,'show_buyer_name',true)){doc.setFont('helvetica','bold');doc.setFontSize(7.2);text(doc,'Buyer (Bill to)',L+3.5,buyerTop+5);doc.setFontSize(9);text(doc,toParty.name,L+3.5,buyerTop+11,115);}
  doc.setFont('helvetica','normal');doc.setFontSize(7.8);
  let by=buyerTop+(bool(s,'show_buyer_name',true)?16:5);
  for(const line of [bool(s,'show_party_address',true)?toParty.address:'',bool(s,'show_party_contact')&&toParty.contact?`Contact : ${toParty.contact}`:'',bool(s,'show_party_gst')&&toParty.gst?`GSTIN : ${toParty.gst}`:'',bool(s,'show_party_pan')&&toParty.pan?`PAN : ${toParty.pan}`:''].map(clean).filter(Boolean)){text(doc,line,L+3.5,by,118);by+=4;}
  if(row.broker_party_name){doc.setFont('helvetica','bold');text(doc,`Broker: ${row.broker_party_name}`,L+3.5,by,118);by+=4;doc.setFont('helvetica','normal');if(row.broker_contact){text(doc,`Broker Contact: ${row.broker_contact}`,L+3.5,by,118);by+=4;}if(row.broker_email){text(doc,`Broker Email: ${row.broker_email}`,L+3.5,by,118);by+=4;}}

  const tableTop=88;
  // Build columns only for enabled fields that have meaningful data. This avoids
  // empty HSN/weight/rate/amount columns when those fields are disabled or absent.
  type BillColumn={key:string;label:string;value:string;weight:number;align?:'left'|'right'};
  const columns:BillColumn[]=[{key:'sl',label:'Sl No.',value:'1',weight:8}];
  columns.push({key:'description',label:'Description of Goods',value:clean(row.goods_description)||clean(row.notes),weight:36});
  if(bool(s,'show_hsn')&&clean(row.hsn))columns.push({key:'hsn',label:'HSN/SAC',value:clean(row.hsn),weight:12});
  const netWeight=Number(row.net_weight||0),grossWeight=Number(row.gross_weight||0);
  // Each checkbox controls its own column. Quantity and Net Weight are separate
  // options; when both are enabled, show both instead of silently dropping one.
  if(bool(s,'show_quantity')&&netWeight>0)columns.push({key:'quantity',label:'Quantity',value:`${kg(netWeight)} Kg`,weight:15});
  if(bool(s,'show_net_weight')&&netWeight>0)columns.push({key:'net',label:'Net Weight',value:`${kg(netWeight)} Kg`,weight:14});
  if(bool(s,'show_gross_weight')&&grossWeight>0)columns.push({key:'gross',label:'Gross Weight',value:`${kg(grossWeight)} Kg`,weight:14});
  if(bool(s,'show_rate')&&Number(row.rate)>0)columns.push({key:'rate',label:'Rate',value:Number(row.rate).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}),weight:12});
  if(bool(s,'show_amount')&&row.gross_amount!==null&&row.gross_amount!==undefined)columns.push({key:'amount',label:'Amount',value:Number(row.gross_amount||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}),weight:16,align:'right'});
  const totalWeight=columns.reduce((a,c)=>a+c.weight,0);
  const widths=columns.map(c=>W*c.weight/totalWeight);
  const xs=[L];for(const width of widths)xs.push(xs[xs.length-1]+width);
  doc.setFont('helvetica','bold');doc.setFontSize(7);
  columns.forEach((c,i)=>{
    const parts=doc.splitTextToSize(c.label,Math.max(8,widths[i]-4));
    parts.slice(0,2).forEach((v:string,j:number)=>text(doc,v,xs[i]+2,tableTop+4.3+j*3.1,Math.max(8,widths[i]-4)));
  });
  const descIndex=columns.findIndex(c=>c.key==='description');
  const amountIndex=columns.findIndex(c=>c.key==='amount');
  const qtyIndex=columns.findIndex(c=>c.key==='quantity');
  let yy=tableTop+17;
  columns.forEach((c,i)=>{
    if(c.key==='description'){
      doc.setFont('helvetica','bold');doc.setFontSize(8);if(c.value)text(doc,c.value,xs[i]+2,yy,Math.max(8,widths[i]-4));
      if(Number(row.bags_qty)>0) {doc.setFont('helvetica','normal');doc.setFontSize(7.5);text(doc,`${kg(row.bags_qty)} Bags`,xs[i]+2,yy+5,Math.max(8,widths[i]-4));}
    } else {
      doc.setFont('helvetica','normal');doc.setFontSize(7.5);
      if(c.key==='amount')right(doc,c.value,xs[i+1]-2,yy);else text(doc,c.value,xs[i]+2,yy,Math.max(8,widths[i]-4));
    }
  });
  // Quantity value already includes its unit (for example, '42,540 Kg'); do not duplicate 'Kg'.

  // Deductions only appear when enabled and non-zero. Their sum is the same
  // sum removed from the printed total; the source purchase record is untouched.
  // Moisture is entered as a percentage; lib/documents/moisture.ts decides how it is shown
  // (percentage in the label, the amount the calculation deducted in the money column).
  // v2.7.0: deduction rows and total come from the shared bill model (same figures in every template).
  const shared=billDeductions(row,s,billType==='third-party'?'third-party':'commercial');
  const visibleDeductions:[string,number][]=descIndex>=0?shared.deductions.map(x=>[x.label,x.amount]):[];
  let ly=yy+17;
  for(const [label,val] of visibleDeductions){
    doc.setDrawColor(185,185,185);doc.setLineWidth(.18);doc.line(xs[descIndex]+1,ly-3,R-1,ly-3);
    doc.setFont('helvetica','normal');doc.setFontSize(7.5);text(doc,'Less :',xs[descIndex]+2,ly);
    doc.setFont('helvetica','bold');doc.setFontSize(7.5);text(doc,label,xs[descIndex]+19,ly,Math.max(8,widths[descIndex]-21));
    if(amountIndex>=0){doc.setFont('helvetica','normal');right(doc,`(-) ${Math.round(val).toLocaleString('en-IN',{maximumFractionDigits:0})}`,xs[amountIndex+1]-2,ly);}
    ly+=5;
  }
  const displayedTotal=descIndex>=0?shared.total:Math.max(0,Math.round(Number(row.gross_amount||0)));
  // Fit the item area to the actual content instead of leaving a huge blank table.
  // Reserve 13 mm between the last deduction and the total row for clean spacing.
  // Use the reference invoice's full-height item grid so totals align near the bottom,
  // while keeping the footer directly below the totals rather than leaving a blank page.
  const tableBottom=Math.max(tableTop+38,218,ly+8);
  doc.rect(L,tableTop,W,tableBottom-tableTop);
  for(let i=1;i<xs.length-1;i++)doc.line(xs[i],tableTop,xs[i],tableBottom);
  doc.line(L,tableTop+11,R,tableTop+11);
  doc.line(L,tableBottom-8,R,tableBottom-8);
  doc.setFont('helvetica','bold');doc.setFontSize(7.5);text(doc,'Total',L+2,tableBottom-3);
  if(qtyIndex>=0)right(doc,`${kg(netWeight)} Kg`,xs[qtyIndex+1]-2,tableBottom-3);
  else { const netIndex=columns.findIndex(c=>c.key==='net'); if(netIndex>=0)right(doc,`${kg(netWeight)} Kg`,xs[netIndex+1]-2,tableBottom-3); }
  if(amountIndex>=0)right(doc,money(displayedTotal),xs[amountIndex+1]-2,tableBottom-3);

  // Bottom block exactly follows the reference's three-column visual balance.
  const bottomTop=tableBottom;
  doc.line(L,bottomTop,R,bottomTop);
  doc.setFont('helvetica','bold');doc.setFontSize(7.3);if(bool(s,'show_amount_words',true)){text(doc,'Amount Chargeable (in words)',L,bottomTop+5);doc.setFontSize(8);text(doc,`INR ${words(displayedTotal)} Only`,L,bottomTop+11,82);}
  doc.setFont('helvetica','bold');doc.setFontSize(7);right(doc,'E. & O.E',R,bottomTop+11);

  if(bool(s,'show_declaration')){
    doc.setFont('helvetica','bold');doc.setFontSize(7.5);text(doc,'Declaration',L,bottomTop+25);
    doc.setFont('helvetica','normal');doc.setFontSize(7.3);text(doc,'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',L,bottomTop+31,86);
  }

  const bankX=111;
  if(bool(s,'show_bank_details')){
    const bankLines=[
      companyBank?.account_holder?`A/c Holder's Name : ${companyBank.account_holder}`:'',
      companyBank?.bank_name?`Bank Name : ${companyBank.bank_name}`:'',
      companyBank?.account_number?`A/c No. : ${companyBank.account_number}`:'',
      companyBank?.branch||companyBank?.ifsc?`Branch & IFS Code : ${[companyBank?.branch,companyBank?.ifsc].filter(Boolean).join(' & ')}`:''
    ].map(clean).filter(Boolean);
    if(bankLines.length){
      doc.setFont('helvetica','bold');doc.setFontSize(7.5);text(doc,"Company's Bank Details",bankX,bottomTop+25);
      doc.setFont('helvetica','normal');doc.setFontSize(7.2);
      let bY=bottomTop+31;
      for(const line of bankLines){text(doc,line,bankX,bY,84);bY+=4.2;}
    }
  }
  if(bool(s,'show_signature')){
    doc.setFont('helvetica','bold');doc.setFontSize(7.5);right(doc,`for ${clean(company.name)||'SOLIVY'}`,R,bottomTop+46);
    doc.line(151,bottomTop+52,R,bottomTop+52);
    doc.setFont('helvetica','normal');right(doc,'Authorised Signatory',R,bottomTop+57);
  }
  doc.setFont('helvetica','normal');doc.setFontSize(7);
  const footerY=Math.min(289,bottomTop+63);
  doc.text('This is a Computer Generated Invoice',105,footerY,{align:'center'});

  const bytes=new Uint8Array(doc.output('arraybuffer'));
  const safe=(clean(row.invoice_no)||clean(row.sample_no)||`purchase-${id}`).replace(/[^A-Za-z0-9_-]/g,'_');
  return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`${disposition}; filename="Commercial-Bill-${safe}.pdf"`,'Cache-Control':'no-store','X-Bill-Total':String(displayedTotal),'X-Bill-Template':'classic'}});
 }catch(e:any){return NextResponse.json({error:e?.message||'Unable to generate commercial bill'},{status:500});}
}

export const runtime = 'nodejs';

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
