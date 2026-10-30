import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../../lib/db';
import {db,Mode} from '../../../../lib/db';import * as XLSX from 'xlsx';
import { moistureDisplay } from '../../../../lib/documents/moisture';async function __bridge_GET(req:Request){
 const mode=sessionMode(req);const u=new URL(req.url);const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);
 const rows0=db(mode,companyId).prepare(`SELECT p.sample_no,x.name party_name,p.purchase_date,p.gross_weight,p.net_weight,p.rate,p.gross_amount,p.freight,p.unload_charge,p.moisture AS moisture_percent,p.discount_pct,p.discount_amount,p.driver_rokdi,p.other_charges,p.quality_deduct_per_mt,p.quality_deduct_rate_per_kg,p.quality_deduct_amount,p.total_deduction,p.net_payable,p.status FROM purchases p JOIN parties x ON x.id=p.party_id ORDER BY p.purchase_date DESC,p.id DESC`).all() as any[];
 const rows=rows0.map((r:any)=>{const out:any={};for(const [k,v] of Object.entries(r)){out[k]=v;if(k==='moisture_percent')out.moisture_deduction=moistureDisplay({...r,moisture:r.moisture_percent}).amount}return out});
 const headers=Object.keys(rows[0]||{});const dateHeaders=headers.filter(h=>/date/i.test(h));const exportRows=rows.map(r=>{const out={...r};for(const h of dateHeaders){const v=out[h];if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v))out[h]=new Date(`${v}T00:00:00`)}return out});
 const wb=XLSX.utils.book_new();const ws=XLSX.utils.json_to_sheet(exportRows,{cellDates:true});for(let ri=1;ri<=exportRows.length;ri++)for(const h of dateHeaders){const ci=headers.indexOf(h);const cell=ws[XLSX.utils.encode_cell({r:ri,c:ci})];if(cell&&cell.t==='d')cell.z='dd-mmm-yyyy'}
 ws['!cols']=headers.map(h=>({wch:Math.min(60,Math.max(12,h.length,...rows.map(r=>String(r[h]??'').length+2)))}));if(headers.length&&rows.length)ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:rows.length,c:headers.length-1}})};XLSX.utils.book_append_sheet(wb,ws,'Purchases');const out=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});return new Response(new Uint8Array(out),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="purchases.xlsx"'}})
}

export const runtime = 'nodejs';

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
