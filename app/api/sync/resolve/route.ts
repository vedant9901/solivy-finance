import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, type Mode } from '../../../../lib/db';
import { storeInverseMappings } from '../../../../lib/sync-id-mapping';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const excluded=new Set(['sync_meta','sync_changes','sync_applied_events','sync_id_mappings','users','sqlite_sequence']);
function safeRemote(raw:string){const u=new URL(raw);if(u.username||u.password||u.search||u.hash)throw new Error('Remote URL must not contain credentials, query strings or fragments.');const local=['localhost','127.0.0.1','::1'].includes(u.hostname);if(u.protocol!=='https:'&&!(local&&u.protocol==='http:'))throw new Error('Remote sync URL must use HTTPS.');return u.toString().replace(/\/+$/,'');}
async function handler(req:Request){
 try{
  const b=await req.json().catch(()=>({}));
  const localCompanyId=Number(req.headers.get('x-aksh-company-id')||0);const mode=String(req.headers.get('x-aksh-mode')||'');
  if(!localCompanyId||!['LIVE','TEST'].includes(mode))return NextResponse.json({error:'Missing active company or environment.'},{status:400});
  const phase=String(b.phase||'');const action=String(b.action||'');const table=String(b.table||'');const key=b.primary_key&&typeof b.primary_key==='object'?b.primary_key:null;const detail=b.conflict_detail||{};const event=b.conflict_event||{};
  if(!['push','pull'].includes(phase)||!['push_local','accept_remote','defer'].includes(action))return NextResponse.json({error:'Invalid conflict action.'},{status:400});
  if(action==='defer')return NextResponse.json({ok:true,deferred:true});
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)||excluded.has(table)||table.startsWith('license_')||table.startsWith('admin_')||!key)return NextResponse.json({error:'Invalid conflict record.'},{status:400});
  const local=db(mode as Mode,localCompanyId);const cols=local.prepare(`PRAGMA table_info("${table}")`).all() as any[];const pk=cols.filter((c:any)=>Number(c.pk)>0).sort((a:any,b:any)=>a.pk-b.pk);if(!cols.length||!pk.length||!pk.every((c:any)=>Object.prototype.hasOwnProperty.call(key,c.name)))return NextResponse.json({error:'The conflict primary key does not match this company database.'},{status:400});
  const localRow=local.prepare(`SELECT * FROM "${table}" WHERE ${pk.map((c:any)=>`"${c.name}"=?`).join(' AND ')}`).get(...pk.map((c:any)=>key[c.name])) as any;
  const localVersion=phase==='push'?(detail.incoming ?? (event.row_json ? JSON.parse(event.row_json) : null)):detail.current;
  const remoteVersion=phase==='push'?detail.current:(detail.incoming ?? (event.row_json ? JSON.parse(event.row_json) : null));
  const row=action==='push_local'?localVersion:remoteVersion;
  if(!row||typeof row!=='object')return NextResponse.json({error:'This conflict involves a missing/deleted record. Use a dedicated delete/recreate resolution; no data was changed.'},{status:409});
  const remoteUrl=safeRemote(String(b.remote_url||''));const token=String(b.device_token||'');const remoteCompanyId=Number(b.remote_company_id||0);if(!token||token.length>300||!remoteCompanyId)return NextResponse.json({error:'Pairing settings are incomplete.'},{status:400});
  const meta=local.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any;const deviceId=String(meta?.device_id||'offline-device');
  const headers={'content-type':'application/json','x-solivy-device-token':token,'x-solivy-device-id':deviceId,'x-aksh-company-id':String(remoteCompanyId),'x-aksh-mode':mode};
  const resolutionId=crypto.randomUUID();
  if(action==='push_local'){
   const response=await fetch(remoteUrl+'/api/sync/exchange',{method:'POST',headers,cache:'no-store',body:JSON.stringify({force_resolution:{resolution_id:resolutionId,table,primary_key:key,row,action:'push-local-version',operation:String(event.operation||'INSERT'),base_json:event.base_json??null}})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)return NextResponse.json({error:data.error||`Remote conflict resolution failed (HTTP ${response.status}).`},{status:response.status||502});
   if(Array.isArray(data.mappings)&&data.mappings.length)storeInverseMappings(local,data.mappings,String(data.destination_device_id||'remote-device'));
   local.exec('CREATE TABLE IF NOT EXISTS sync_resolution_log (resolution_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, device_id TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)');
   const tx=local.transaction(()=>{local.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),'push-local-version',localRow?JSON.stringify(localRow):null,JSON.stringify(row),deviceId);if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));if(phase==='pull')local.prepare('UPDATE sync_changes SET pushed=1 WHERE table_name=? AND pk_json=?').run(table,JSON.stringify(key));});tx();
   return NextResponse.json({ok:true,resolved:true,action,phase,message:'This device version was sent to the token-authorized destination. Retry Sync Now to exchange remaining changes.'});
  }
  // Accept the other side's version on this device. Use a local transaction and suppress
  // trigger-generated duplicate journal rows; write one auditable resolution record.
  local.exec('CREATE TABLE IF NOT EXISTS sync_resolution_log (resolution_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, device_id TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const names=cols.map((c:any)=>String(c.name)).filter((n:string)=>Object.prototype.hasOwnProperty.call(row,n));if(!names.length)return NextResponse.json({error:'Incoming version has no compatible fields.'},{status:400});
  const updates=names.filter((n:string)=>!pk.some((c:any)=>c.name===n)).map((n:string)=>`"${n}"=excluded."${n}"`).join(',');const sql=`INSERT INTO "${table}" (${names.map((n:string)=>`"${n}"`).join(',')}) VALUES (${names.map(()=>'?').join(',')}) ON CONFLICT (${pk.map((c:any)=>`"${c.name}"`).join(',')}) ${updates?`DO UPDATE SET ${updates}`:'DO NOTHING'}`;
  const tx=local.transaction(()=>{local.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();try{local.prepare(sql).run(...names.map((n:string)=>row[n]===undefined?null:row[n]));}finally{local.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run();}local.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),'accept-remote-version',localRow?JSON.stringify(localRow):null,JSON.stringify(row),deviceId);if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));if(phase==='pull'&&event.event_id)local.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(event.event_id));});tx();
  return NextResponse.json({ok:true,resolved:true,action,phase,message:'The other company version was accepted on this device. Retry Sync Now to continue processing queued events.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Conflict resolution failed; no further changes were attempted.'},{status:400});}
}
const __wrapped_POST=withPostgresSQLiteBridge(handler);
export async function POST(req:Request){return __wrapped_POST(req);}
