import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, type Mode } from '../../../../lib/db';
import { storeInverseMappings } from '../../../../lib/sync-id-mapping';
import { classifyConflict, resolutionIdFor, applyResolvedDelete, alreadyResolved, ensureResolutionLog, dependentsOf } from '../../../../lib/sync-delete';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { clearRejectsFor } from '../../../../lib/sync-quarantine';
import { SYNC_EXCLUDED_TABLES } from '../../../../lib/sync-eligibility';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// v2.8.1: one shared membership (lib/sync-eligibility.ts).
const excluded=SYNC_EXCLUDED_TABLES;
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
  const remoteUrl=safeRemote(String(b.remote_url||''));const token=String(b.device_token||'');const remoteCompanyId=Number(b.remote_company_id||0);if(!token||token.length>300||!remoteCompanyId)return NextResponse.json({error:'Pairing settings are incomplete.'},{status:400});
  const meta=local.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any;const deviceId=String(meta?.device_id||'offline-device');
  const headers={'content-type':'application/json','x-solivy-device-token':token,'x-solivy-device-id':deviceId,'x-aksh-company-id':String(remoteCompanyId),'x-aksh-mode':mode};
  // v2.8.0: derived from the conflict, so retrying a resolution applies it exactly once.
  const resolutionId=resolutionIdFor({phase,action,table,key,eventId:String(event.event_id||'')});
  const kind=classifyConflict({localRow,localVersion,remoteVersion,operation:String(event.operation||''),phase});
  const cascade=b.cascade===true;const override=b.override===true;
  const deleteBase=(()=>{try{return event.base_json?JSON.parse(event.base_json):(detail.base??null)}catch{return null}})();
  ensureResolutionLog(local);

  // ---- delete / recreate resolutions (the case that previously had no way out) ----------------
  if(!row||typeof row!=='object'){
    if(kind==='both-deleted'){
      const tx=local.transaction(()=>{
        local.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),'already-deleted-both-sides',localRow?JSON.stringify(localRow):null,null,deviceId);
        if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));
        if(phase==='pull'&&event.event_id)local.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(event.event_id));
      });tx();
      return NextResponse.json({ok:true,resolved:true,action,phase,kind,message:'The record is already absent on both devices. The conflict is cleared and nothing was changed.'});
    }
    if(action==='accept_remote'){
      // The other device deleted the record: delete it here too, guarded and audited.
      if(alreadyResolved(local,resolutionId))return NextResponse.json({ok:true,already_resolved:true,kind,message:'This deletion was already applied on this device.'});
      const res=applyResolvedDelete(local,{table,key,pk,resolutionId,deviceId,cascade,base:deleteBase,override,action:'accept-remote-delete'});
      if(res.guard&&!res.guard.ok)return NextResponse.json({error:res.guard.message,code:res.guard.code,dependents:res.guard.dependents,needs_confirmation:res.guard.code==='HAS_DEPENDENTS',needs_override:res.guard.code!=='POSTED_RECORD'&&res.guard.code!=='HAS_DEPENDENTS'},{status:409});
      const tx=local.transaction(()=>{
        if(phase==='pull'&&event.event_id)local.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(event.event_id));
        if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));
      });tx();
      return NextResponse.json({ok:true,resolved:true,action,phase,kind,deleted:res.outcome?res.outcome.deleted:0,cascaded:res.outcome?res.outcome.cascaded:[],message:res.outcome?'The record was deleted on this device to match the other side. A recovery copy is kept in the resolution log.':'The record was already absent here; the conflict is cleared.'});
    }
    // push_local with nothing here means "my deletion is the truth": send the delete upstream.
    const dependants=dependentsOf(local,table,key);
    const response=await fetch(remoteUrl+'/api/sync/exchange',{method:'POST',headers,cache:'no-store',body:JSON.stringify({force_resolution:{resolution_id:resolutionId,table,primary_key:key,action:'push-local-delete',operation:'DELETE',base_json:event.base_json??(deleteBase?JSON.stringify(deleteBase):null),cascade,override}})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.ok)return NextResponse.json({error:data.error||`Remote conflict resolution failed (HTTP ${response.status}).`,code:data.code,dependents:data.dependents,needs_confirmation:data.needs_confirmation,needs_override:data.needs_override},{status:response.status||502});
    const tx=local.transaction(()=>{
      local.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),'push-local-delete',localRow?JSON.stringify(localRow):(deleteBase?JSON.stringify(deleteBase):null),null,deviceId);
      if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));
      if(phase==='pull')local.prepare('UPDATE sync_changes SET pushed=1 WHERE table_name=? AND pk_json=?').run(table,JSON.stringify(key));
      if(phase==='pull'&&event.event_id)local.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(event.event_id));
    });tx();
    void dependants;
    return NextResponse.json({ok:true,resolved:true,action,phase,kind,remote_deleted:data.deleted??0,cascaded:data.cascaded||[],message:'The deletion made on this device was applied on the other side. Retry Sync Now to exchange remaining changes.'});
  }
  if(alreadyResolved(local,resolutionId))return NextResponse.json({ok:true,already_resolved:true,kind,message:'This resolution was already applied on this device.'});
  if(action==='push_local'){
   const response=await fetch(remoteUrl+'/api/sync/exchange',{method:'POST',headers,cache:'no-store',body:JSON.stringify({force_resolution:{resolution_id:resolutionId,table,primary_key:key,row,action:'push-local-version',operation:String(event.operation||'INSERT'),base_json:event.base_json??null}})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)return NextResponse.json({error:data.error||`Remote conflict resolution failed (HTTP ${response.status}).`},{status:response.status||502});
   if(Array.isArray(data.mappings)&&data.mappings.length)storeInverseMappings(local,data.mappings,String(data.destination_device_id||'remote-device'));
   local.exec('CREATE TABLE IF NOT EXISTS sync_resolution_log (resolution_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, device_id TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)');
   const tx=local.transaction(()=>{local.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),'push-local-version',localRow?JSON.stringify(localRow):null,JSON.stringify(row),deviceId);if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));if(phase==='pull'){local.prepare('UPDATE sync_changes SET pushed=1 WHERE table_name=? AND pk_json=?').run(table,JSON.stringify(key));
    // v2.8.0: keeping this device's version is a decision about the incoming event, so that event
    // is recorded as handled. Without this the same event was pulled and re-conflicted forever.
    if(event.event_id)local.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(event.event_id));}});tx();
   return NextResponse.json({ok:true,resolved:true,action,phase,message:'This device version was sent to the token-authorized destination. Retry Sync Now to exchange remaining changes.'});
  }
  // Accept the other side's version on this device. Use a local transaction and suppress
  // trigger-generated duplicate journal rows; write one auditable resolution record.
  local.exec('CREATE TABLE IF NOT EXISTS sync_resolution_log (resolution_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, device_id TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const names=cols.map((c:any)=>String(c.name)).filter((n:string)=>Object.prototype.hasOwnProperty.call(row,n));if(!names.length)return NextResponse.json({error:'Incoming version has no compatible fields.'},{status:400});
  const updates=names.filter((n:string)=>!pk.some((c:any)=>c.name===n)).map((n:string)=>`"${n}"=excluded."${n}"`).join(',');const sql=`INSERT INTO "${table}" (${names.map((n:string)=>`"${n}"`).join(',')}) VALUES (${names.map(()=>'?').join(',')}) ON CONFLICT (${pk.map((c:any)=>`"${c.name}"`).join(',')}) ${updates?`DO UPDATE SET ${updates}`:'DO NOTHING'}`;
  const tx=local.transaction(()=>{local.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();try{local.prepare(sql).run(...names.map((n:string)=>row[n]===undefined?null:row[n]));}finally{local.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run();}local.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),localRow?'accept-remote-version':'recreate-from-remote',localRow?JSON.stringify(localRow):null,JSON.stringify(row),deviceId);if(phase==='push'&&event.event_id)local.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(String(event.event_id));if(phase==='pull'&&event.event_id)local.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(event.event_id));});tx();
  return NextResponse.json({ok:true,resolved:true,action,phase,message:'The other company version was accepted on this device. Retry Sync Now to continue processing queued events.'});
 }catch(e:any){return NextResponse.json({error:e?.message||'Conflict resolution failed; no further changes were attempted.'},{status:400});}
}
// v2.8.1: a successful resolution also closes the quarantine entry that the conflicting item
// created, so a resolved record stops appearing as blocked and its queued change is retried.
async function resolveAndClear(req:Request){
  let asked:any=null;
  try { asked=await req.clone().json(); } catch { asked=null; }
  const res=await handler(req);
  try {
    const data=await res.clone().json().catch(()=>({} as any));
    const table=String(asked?.table||'');
    const key=asked?.primary_key&&typeof asked.primary_key==='object'?asked.primary_key:null;
    const companyId=Number(req.headers.get('x-aksh-company-id')||0); const mode=String(req.headers.get('x-aksh-mode')||'');
    if((data?.resolved||data?.already_resolved||data?.deferred===undefined&&data?.ok)&&table&&key&&companyId&&['LIVE','TEST'].includes(mode)&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      clearRejectsFor(db(mode as Mode,companyId),table,key);
    }
  } catch(err) { console.error('SOLIVY sync quarantine clear failed',(err as any)?.message||err); }
  return res;
}
const __wrapped_POST=withPostgresSQLiteBridge(resolveAndClear,{noRetry:true});
export async function POST(req:Request){return __wrapped_POST(req);}
