import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../../lib/db';
import {db,Mode} from '../../../../lib/db';import * as XLSX from 'xlsx';async function __bridge_GET(req:Request){
 const u=new URL(req.url);const mode=sessionMode(req);const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1);
 const rows=db(mode,companyId).prepare(`SELECT l.entry_date,p.name party_name,l.entry_type,l.reference_no,l.debit,l.credit,l.narration FROM ledger l JOIN parties p ON p.id=l.party_id ORDER BY l.entry_date DESC,l.id DESC`).all() as any[];
 const headers=Object.keys(rows[0]||{});const dateHeaders=headers.filter(h=>/date/i.test(h));const exportRows=rows.map(r=>{const out={...r};for(const h of dateHeaders){const v=out[h];if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v))out[h]=new Date(`${v}T00:00:00`)}return out});
 const wb=XLSX.utils.book_new();const ws=XLSX.utils.json_to_sheet(exportRows,{cellDates:true});for(let ri=1;ri<=exportRows.length;ri++)for(const h of dateHeaders){const ci=headers.indexOf(h);const cell=ws[XLSX.utils.encode_cell({r:ri,c:ci})];if(cell&&cell.t==='d')cell.z='dd-mmm-yyyy'}
 ws['!cols']=headers.map(h=>({wch:Math.min(60,Math.max(12,h.length,...rows.map(r=>String(r[h]??'').length+2)))}));if(headers.length&&rows.length)ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:rows.length,c:headers.length-1}})};XLSX.utils.book_append_sheet(wb,ws,'Ledger');const out=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});return new Response(new Uint8Array(out),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="party-wise-ledger.xlsx"'}})
}

export const runtime = 'nodejs';

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
