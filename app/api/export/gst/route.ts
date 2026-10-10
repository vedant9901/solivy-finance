import { sessionMode } from '../../../../lib/db';
import {db,Mode} from '../../../../lib/db';
import * as XLSX from 'xlsx';
export async function GET(req:Request){
 const u=new URL(req.url); const mode = sessionMode(req); const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1); const d=db(mode,companyId);
 const rows=d.prepare(`SELECT invoice_no AS 'Invoice Number',invoice_date AS 'Invoice Date',customer_name AS 'Customer Name',customer_gstin AS 'Customer GSTIN',place_of_supply AS 'Place Of Supply',invoice_type AS 'Invoice Type',hsn AS 'HSN/SAC',description AS 'Description',taxable_value AS 'Taxable Value',gst_rate AS 'GST Rate',cgst AS 'CGST',sgst AS 'SGST',igst AS 'IGST',total_value AS 'Invoice Value' FROM sales WHERE status='POSTED' ORDER BY invoice_date,invoice_no`).all();
 const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'GSTR-1');
 const out=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}); return new Response(new Uint8Array(out),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="gst-filing-register.xlsx"'}});
}
