import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import {NextResponse} from 'next/server';import {db,Mode} from '../../../lib/db';
async function __bridge_POST(req:Request){try{
 const x=await req.json();
 const companyId=Number(req.headers.get('x-aksh-company-id')||x.company_id||1);
 const d=db(sessionMode(req),companyId);
 const requestedStart=Math.max(0,Math.floor(Number(x.purchase_bill_start_after||0)));
 const oldSettings=d.prepare('SELECT purchase_bill_start_after FROM company_settings WHERE id=1').get() as any;
 const oldStart=Math.max(0,Math.floor(Number(oldSettings?.purchase_bill_start_after||0)));
 const currentBills=d.prepare('SELECT id,bill_number FROM purchases ORDER BY id ASC').all() as any[];
 const sequenceMatches=currentBills.every((r:any,i:number)=>Number(r.bill_number)===requestedStart+i+1);
 const renumber=oldStart!==requestedStart||!sequenceMatches;
 const apply=d.transaction(()=>{
   d.prepare('UPDATE company_settings SET entity_name=?,tan=?,deductor_type=?,preceding_turnover=?,purchase_bill_start_after=?,discount_after_quality=?,tds_auto=1,updated_at=CURRENT_TIMESTAMP WHERE id=1').run(x.entity_name||'SOLIVY',x.tan||'',x.deductor_type||'COMPANY',Number(x.preceding_turnover||0),requestedStart,Number(x.discount_after_quality??1)===1?1:0);
   let changed=0;
   if(renumber){
     const rows=d.prepare('SELECT id,bill_number FROM purchases ORDER BY id ASC').all() as any[];
     // Move existing values out of the unique-index range before assigning the new sequence.
     // Purchase primary keys and all foreign-key relationships remain unchanged.
     const moveTemp=d.prepare('UPDATE purchases SET bill_number=? WHERE id=?');
     rows.forEach((r:any,i:number)=>moveTemp.run(-1000000000000-i,Number(r.id)));
     const assign=d.prepare('UPDATE purchases SET bill_number=? WHERE id=?');
     rows.forEach((r:any,i:number)=>{const next=requestedStart+i+1;if(Number(r.bill_number)!==next)changed++;assign.run(next,Number(r.id));});
     try{d.prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(String(req.headers.get('x-aksh-user')||'unknown'),'RENUMBER_PURCHASE_BILLS','PURCHASES',null,JSON.stringify({companyId,mode:sessionMode(req),previousStartAfter:oldStart,newStartAfter:requestedStart,recordsRenumbered:rows.length,changedNumbers:changed,orderedBy:'purchase id ASC',preservedPurchaseIds:true}));}catch{}
   }
   return {renumbered:renumber,recordsRenumbered:renumber?Number((d.prepare('SELECT COUNT(*) c FROM purchases').get() as any)?.c||0):0,changedNumbers:changed};
 });
 const result=apply();
 return NextResponse.json({ok:true,...result,message:result.renumbered?`Purchase bill numbers reassigned sequentially from ${requestedStart+1}. Third-party bills use the updated linked purchase bill number.`:'Settings saved. Purchase bill numbers were not changed because the starting value is unchanged.'});
 }catch(e:any){return NextResponse.json({error:e.message},{status:400})}}

export const runtime = 'nodejs';

const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }
