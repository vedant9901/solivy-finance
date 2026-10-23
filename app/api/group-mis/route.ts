import { NextResponse } from 'next/server';
import { adminDb, db, type Mode } from '../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
export const runtime='nodejs'; export const dynamic='force-dynamic';
const monthStart=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;};
async function handler(req:Request){try{
 const a=adminDb(),username=String(req.headers.get('x-aksh-user')||''),role=String(req.headers.get('x-aksh-role')||''),current=Number(req.headers.get('x-aksh-company-id')||new URL(req.url).searchParams.get('company_id')||0),mode=(req.headers.get('x-aksh-mode')==='TEST'?'TEST':'LIVE') as Mode;
 if(!username||!current)return NextResponse.json({error:'Sign in and select an organization first.'},{status:401});
 let available:any[]=[];
 if(role==='ADMIN') available=a.prepare('SELECT id,name,code FROM companies WHERE active=1 ORDER BY name').all() as any[];
 else {const u=a.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(username) as any;if(!u)return NextResponse.json({error:'Active user not found.'},{status:403});available=a.prepare(`SELECT c.id,c.name,c.code FROM companies c JOIN user_companies uc ON uc.company_id=c.id WHERE uc.user_id=? AND c.active=1 AND ${mode==='TEST'?'uc.can_test=1':'uc.can_live=1'} ORDER BY c.name`).all(u.id) as any[];}
 if(!available.some(c=>Number(c.id)===current))return NextResponse.json({error:'You are not mapped to the selected organization in this environment.'},{status:403});
 const raw=new URL(req.url).searchParams.get('company_ids');let selected=available;
 if(raw){const ids=[...new Set(raw.split(',').map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];if(!ids.length)return NextResponse.json({error:'Select at least one organization.'},{status:400});if(ids.some(id=>!available.some(c=>Number(c.id)===id)))return NextResponse.json({error:'One or more selected organizations are not available to this user in this environment.'},{status:403});selected=available.filter(c=>ids.includes(Number(c.id)));}
 const start=monthStart(),perCompany:any[]=[],top:any[]=[];let inflow=0,outflow=0,monthInflow=0,monthOutflow=0;
 for(const c of selected){const d=db(mode,Number(c.id));
 const cf=d.prepare(`SELECT COALESCE(SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE 0 END),0) inflow,COALESCE(SUM(CASE WHEN transaction_type='DEBIT' THEN amount ELSE 0 END),0) outflow,COALESCE(SUM(CASE WHEN transaction_type='CREDIT' AND substr(transaction_date,1,10)>=? THEN amount ELSE 0 END),0) month_inflow,COALESCE(SUM(CASE WHEN transaction_type='DEBIT' AND substr(transaction_date,1,10)>=? THEN amount ELSE 0 END),0) month_outflow FROM account_transactions WHERE NOT (UPPER(COALESCE(reference_type,''))='ACCOUNT_MOVEMENT' AND reference_id IN (SELECT id FROM account_movements WHERE UPPER(movement_type)='TRANSFER'))`).get(start,start) as any;
 const row={company_id:Number(c.id),company_name:String(c.name),company_code:String(c.code||''),inflow:Number(cf.inflow||0),outflow:Number(cf.outflow||0),net:Number(cf.inflow||0)-Number(cf.outflow||0),month_inflow:Number(cf.month_inflow||0),month_outflow:Number(cf.month_outflow||0),month_net:Number(cf.month_inflow||0)-Number(cf.month_outflow||0)};perCompany.push(row);inflow+=row.inflow;outflow+=row.outflow;monthInflow+=row.month_inflow;monthOutflow+=row.month_outflow;
 // Ranking is purchase-based (posted net payable), not cash in/out or ledger volume.
 const pts=d.prepare(`SELECT p.name party_name,COUNT(*) purchase_count,COALESCE(SUM(x.net_payable),0) purchase_value FROM purchases x JOIN parties p ON p.id=x.party_id WHERE x.status='POSTED' GROUP BY p.id,p.name ORDER BY purchase_value DESC LIMIT 15`).all() as any[];
 for(const pt of pts)top.push({company_id:Number(c.id),company_name:String(c.name),party_name:String(pt.party_name),purchase_count:Number(pt.purchase_count||0),purchase_value:Number(pt.purchase_value||0)});
 }
 top.sort((x,y)=>y.purchase_value-x.purchase_value);
 return NextResponse.json({ok:true,mode,as_of:new Date().toISOString(),month_start:start,available_companies:available.map(c=>({company_id:Number(c.id),company_name:String(c.name),company_code:String(c.code||'')})),selected_company_ids:selected.map(c=>Number(c.id)),company_count:selected.length,totals:{inflow,outflow,net:inflow-outflow,month_inflow:monthInflow,month_outflow:monthOutflow,month_net:monthInflow-monthOutflow},companies:perCompany,top_parties:top.slice(0,20),currency_note:'Amounts are summed as stored. Compare totals only when selected organizations use the same currency; no FX conversion is applied. Top parties are ranked by posted purchase net payable, not cashflow.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Unable to calculate consolidated MIS.'},{status:500})}}
const wrapped=withPostgresSQLiteBridge(handler);export async function GET(req:Request){return wrapped(req)}
