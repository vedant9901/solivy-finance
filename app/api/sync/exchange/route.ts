import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminDb, db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { reconcileIncomingEvent, importPeerMappings } from '../../../../lib/sync-id-mapping';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


function mergeChangedFields(base:any, current:any, incoming:any, cols:any[]) {
  const merged:any={}; const conflicts:any[]=[];
  for (const c of cols) {
    const k=String(c.name); const b=base?.[k], a=current?.[k], n=incoming?.[k];
    if (Number(c.pk)>0) { merged[k]=a===undefined?n:a; continue; }
    if (canon(a)===canon(n)) { merged[k]=a; continue; }
    if (canon(a)===canon(b)) { merged[k]=n; continue; }
    if (canon(n)===canon(b)) { merged[k]=a; continue; }
    // Same field changed differently on both sides: retain the local value in the live row
    // and preserve both values in the conflict audit so neither edit is silently discarded.
    merged[k]=canon(a)<=canon(n)?a:n; conflicts.push({field:k,base:b,local:a,incoming:n,chosen:merged[k]});
  }
  return {merged,conflicts};
}
function ensureConflictHistory(d:any) {
  d.exec("CREATE TABLE IF NOT EXISTS sync_conflict_history (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, field_name TEXT NOT NULL, base_value TEXT, local_value TEXT, incoming_value TEXT, resolution TEXT NOT NULL DEFAULT 'kept_local_audit_both', created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
}

const excluded = new Set(['sync_meta','sync_changes','sync_applied_events','sync_id_mappings','users','sqlite_sequence']);
const canon = (v:any):string => {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '['+v.map(canon).join(',')+']';
  if (typeof v === 'object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
  return JSON.stringify(v);
};
function tokenContext(req:Request) {
  const token = String(req.headers.get('x-solivy-device-token') || '');
  const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
  const mode = String(req.headers.get('x-aksh-mode') || '');
  const deviceId = String(req.headers.get('x-solivy-device-id') || '');
  if (!token || token.length > 300 || !companyId || !['LIVE','TEST'].includes(mode) || !deviceId || deviceId.length > 100) throw new Error('Invalid sync device credentials.');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = adminDb().prepare('SELECT id,company_id,mode,active FROM sync_devices WHERE token_hash=?').get(hash) as any;
  if (!row || !row.active || Number(row.company_id)!==companyId || row.mode!==mode) throw new Error('Sync device is not authorized for this company/environment.');
  adminDb().prepare('UPDATE sync_devices SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
  return {companyId,mode:mode as Mode,deviceId};
}
function tableInfo(d:any, table:string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || excluded.has(table) || table.startsWith('license_') || table.startsWith('admin_')) throw new Error('Table is not eligible for synchronization.');
  const exists=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) throw new Error('Unknown synchronized table: '+table);
  const cols=d.prepare(`PRAGMA table_info("${table}")`).all() as any[];
  const pk=cols.filter(c=>Number(c.pk)>0).sort((a,b)=>a.pk-b.pk);
  if (!cols.length || !pk.length) throw new Error('Table has no supported primary key.');
  return {cols,pk};
}

function mergeInitialCompanySettings(current:any, incoming:any, cols:any[], companyName='') {
  const merged:any = {};
  const conflicts:any[] = [];
  const empty = (name:string, value:any) => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return true;
    // Default empty JSON settings are placeholders, not competing user choices.
    if (name.endsWith('_settings') && typeof value === 'string') {
      try { const parsed=JSON.parse(value); if (parsed && typeof parsed==='object' && !Array.isArray(parsed) && Object.keys(parsed).length===0) return true; } catch { /* malformed settings are not treated as empty */ }
    }
    return false;
  };
  const orgName=String(companyName||'').trim();
  for (const col of cols) {
    const name=String(col.name), a=current?.[name], b=incoming?.[name];
    if (Number(col.pk)>0) { merged[name]=a===undefined?b:a; continue; }
    // On a newly provisioned organization, 'SOLIVY' can be the schema default
    // left behind if the organization row was created before its company snapshot.
    // Only reconcile this exact placeholder when the incoming name matches the
    // authenticated destination organization's master record.
    if (name==='entity_name' && orgName && orgName.toUpperCase()!=='SOLIVY') {
      if (String(a||'').trim().toUpperCase()==='SOLIVY' && String(b||'').trim().toUpperCase()===orgName.toUpperCase()) { merged[name]=b; continue; }
      if (String(b||'').trim().toUpperCase()==='SOLIVY' && String(a||'').trim().toUpperCase()===orgName.toUpperCase()) { merged[name]=a; continue; }
    }
    if (canon(a)===canon(b)) { merged[name]=a; continue; }
    if (name==='updated_at' && !empty(name,a) && !empty(name,b)) { merged[name]=String(a)>=String(b)?a:b; continue; }
    if (name==='created_at' && !empty(name,a) && !empty(name,b)) { merged[name]=String(a)<=String(b)?a:b; continue; }
    if (empty(name,a)) { merged[name]=b; continue; }
    if (empty(name,b)) { merged[name]=a; continue; }
    conflicts.push({field:name,existing:a,incoming:b});
    merged[name]=a;
  }
  return {merged,conflicts};
}

function currentRow(d:any,table:string,pkCols:any[],pkObj:any) {
  const where=pkCols.map(c=>`"${c.name}"=?`).join(' AND ');
  const vals=pkCols.map(c=>pkObj[c.name]);
  return d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...vals) as any;
}
function applyEvent(d:any,e:any,localDeviceId:string,companyName:string) {
  if (!e || typeof e.event_id!=='string' || e.event_id.length>100 || !['INSERT','UPDATE','DELETE'].includes(e.operation)) throw new Error('Invalid sync event.');
  if (d.prepare('SELECT event_id FROM sync_applied_events WHERE event_id=?').get(e.event_id)) return 'duplicate';
  const {cols,pk}=tableInfo(d,String(e.table_name));
  const pkObj=JSON.parse(String(e.pk_json||'{}'));
  if (!pk.every(c=>Object.prototype.hasOwnProperty.call(pkObj,c.name))) throw new Error('Invalid primary key in sync event.');
  const current=currentRow(d,e.table_name,pk,pkObj);
  const desired=e.row_json ? JSON.parse(e.row_json) : null;
  const base=e.base_json ? JSON.parse(e.base_json) : null;
  if (current && desired && canon(current)===canon(desired)) {
    d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
    d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)')
      .run(e.event_id,e.table_name,e.pk_json,e.operation,e.base_json,e.row_json,e.origin_device||'remote');
    return 'already-current';
  }
  if (base===null && current && e.table_name==='company_settings' && e.operation==='INSERT' && desired && typeof desired==='object') {
    const {merged,conflicts}=mergeInitialCompanySettings(current,desired,cols,companyName);
    if(conflicts.length) throw Object.assign(new Error(`Conflict on company_settings: non-empty fields differ (${conflicts.map((x:any)=>x.field).join(', ')}). Review both versions.`), { conflictDetail: { table: 'company_settings', primary_key: pkObj, reason: 'Initial company settings can be merged only when fields do not disagree. Review the listed fields before retrying.', field_conflicts: conflicts, base: null, current, incoming: desired } });
    d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
    try {
      const names=cols.map((c:any)=>String(c.name)).filter((n:string)=>!pk.some((c:any)=>c.name===n));
      if(names.length)d.prepare(`UPDATE "company_settings" SET ${names.map((n:string)=>`"${n}"=?`).join(',')} WHERE ${pk.map((c:any)=>`"${c.name}"=?`).join(' AND ')}`).run(...names.map((n:string)=>merged[n]===undefined?null:merged[n]),...pk.map((c:any)=>pkObj[c.name]));
      d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
      d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(e.event_id,e.table_name,e.pk_json,e.operation,e.base_json,e.row_json,e.origin_device||'remote');
      const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'remote-device');
      d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(crypto.randomUUID(),'company_settings',e.pk_json,'UPDATE',JSON.stringify(desired),JSON.stringify(merged),ownDevice);
    } finally { d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run(); }
    return 'merged-settings';
  }
  let effectiveRow=desired; let fieldConflicts:any[]=[];
  if(base===null && current && e.table_name!=='company_settings' && e.operation==='INSERT' && desired && typeof desired==='object') {
    throw Object.assign(new Error(`Identity collision on ${e.table_name}; safe ID mapping is required before applying this insert.`), { conflictDetail: { table:String(e.table_name), primary_key:pkObj, reason:'The source record has a colliding primary key and no safe ID mapping was supplied.', base:null, current, incoming:desired } });
  } else if(base!==null && current && desired && typeof desired==='object' && canon(current)!==canon(base)) {
    const merged=mergeChangedFields(base,current,desired,cols); effectiveRow=merged.merged; fieldConflicts=merged.conflicts;
    if(fieldConflicts.length){ensureConflictHistory(d);const log=d.prepare('INSERT INTO sync_conflict_history(event_id,table_name,pk_json,field_name,base_value,local_value,incoming_value) VALUES(?,?,?,?,?,?,?)');for(const c of fieldConflicts)log.run(String(e.event_id),String(e.table_name),JSON.stringify(pkObj),c.field,JSON.stringify(c.base),JSON.stringify(c.local),JSON.stringify(c.incoming));}
  } else if(base!==null && !current) {
    throw Object.assign(new Error(`Cannot merge ${e.table_name}: the base record was deleted on the destination.`), { conflictDetail: { table:String(e.table_name), primary_key:pkObj, reason:'The record was deleted on this side while the other side edited it.', base, current:null, incoming:desired } });
  }
  d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
  try {
    if (e.operation==='DELETE') {
      if (current) d.prepare(`DELETE FROM "${e.table_name}" WHERE ${pk.map(c=>`"${c.name}"=?`).join(' AND ')}`).run(...pk.map(c=>pkObj[c.name]));
    } else {
      if (!effectiveRow || typeof effectiveRow!=='object') throw new Error('Missing row payload.');
      const names=cols.map(c=>c.name).filter(n=>Object.prototype.hasOwnProperty.call(effectiveRow,n));
      if (!names.length || !pk.every(c=>names.includes(c.name))) throw new Error('Row payload is incomplete.');
      const quoted=names.map(n=>`"${n}"`).join(',');
      const marks=names.map(()=>'?').join(',');
      const updates=names.filter(n=>!pk.some(c=>c.name===n)).map(n=>`"${n}"=excluded."${n}"`).join(',');
      const conflict=pk.map(c=>`"${c.name}"`).join(',');
      const sql=`INSERT INTO "${e.table_name}" (${quoted}) VALUES (${marks}) ON CONFLICT (${conflict}) ${updates ? `DO UPDATE SET ${updates}` : 'DO NOTHING'}`;
      d.prepare(sql).run(...names.map(n=>effectiveRow[n]===undefined?null:effectiveRow[n]));
    }
    d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
    d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)')
      .run(e.event_id,e.table_name,e.pk_json,e.operation,e.base_json,JSON.stringify(effectiveRow),e.origin_device||'remote');
    if(fieldConflicts.length){const own=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'remote-device');d.prepare('INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,0)').run(crypto.randomUUID(),e.table_name,e.pk_json,'UPDATE',JSON.stringify(current),JSON.stringify(effectiveRow),own);}
  } finally {
    d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run();
  }
  return 'applied';
}
async function handler(req:Request) {
  let ctx:any;
  try { ctx=tokenContext(req); }
  catch(e:any) { return NextResponse.json({error:e?.message||'Unauthorized sync device.'},{status:401}); }
  const d=db(ctx.mode,ctx.companyId);
  const organization=adminDb().prepare('SELECT name,active FROM companies WHERE id=?').get(ctx.companyId) as any;
  if(!organization || !organization.active) return NextResponse.json({error:'The paired destination organization is missing or inactive.'},{status:403});
  const companyName=String(organization.name||'');
  try {
    if (req.method==='GET') {
      const u=new URL(req.url);
      const cursor=Math.max(0,Number(u.searchParams.get('cursor')||0));
      const limit=Math.min(500,Math.max(1,Number(u.searchParams.get('limit')||200)));
      const events=d.prepare(`SELECT seq,event_id,table_name,pk_json,operation,base_json,row_json,origin_device,created_at FROM sync_changes WHERE seq>? AND origin_device<>? ORDER BY seq LIMIT ?`).all(cursor,ctx.deviceId,limit) as any[];
      const max=d.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM sync_changes').get() as any;
      const hasMore=events.length===limit;
      const nextCursor=hasMore?Number(events[events.length-1]?.seq||cursor):Number(max?.n||cursor);
      const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'remote-device');
      return NextResponse.json({ok:true,events,cursor:nextCursor,has_more:hasMore,destination_device_id:ownDevice,company_id:ctx.companyId,company_name:companyName,mode:ctx.mode});
    }
    if (req.method==='POST') {
      const body=await req.json().catch(()=>({}));
      if (body.force_resolution && typeof body.force_resolution==='object') {
        const f=body.force_resolution as any;
        const table=String(f.table||'');
        const {cols,pk}=tableInfo(d,table);
        let key=f.primary_key && typeof f.primary_key==='object' ? f.primary_key : {};
        if(!pk.every((c:any)=>Object.prototype.hasOwnProperty.call(key,c.name))) return NextResponse.json({error:'Invalid conflict primary key.'},{status:400});
        let row=f.row && typeof f.row==='object' ? f.row : null;
        if(!row || !pk.every((c:any)=>Object.prototype.hasOwnProperty.call(row,c.name))) return NextResponse.json({error:'The selected source version is incomplete.'},{status:400});
        const resolutionId=String(f.resolution_id||'');
        if(!resolutionId || resolutionId.length>120) return NextResponse.json({error:'Missing conflict resolution ID.'},{status:400});
        const mappings:any[]=[];
        if(String(f.action||'')==='push-local-version' && String(f.operation||'')==='INSERT' && (f.base_json===null || f.base_json===undefined || f.base_json==='')) {
          const reconciled=reconcileIncomingEvent(d,{event_id:'resolution-'+resolutionId,table_name:table,pk_json:JSON.stringify(key),operation:'INSERT',base_json:null,row_json:JSON.stringify(row),origin_device:ctx.deviceId},ctx.deviceId,mappings);
          try { key=JSON.parse(String(reconciled.pk_json||JSON.stringify(key))); row=JSON.parse(String(reconciled.row_json||JSON.stringify(row))); } catch { return NextResponse.json({error:'Could not safely remap the conflicting record identity.'},{status:409}); }
        }
        d.exec(`CREATE TABLE IF NOT EXISTS sync_resolution_log (resolution_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, device_id TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
        const prior=d.prepare('SELECT resolution_id FROM sync_resolution_log WHERE resolution_id=?').get(resolutionId);
        if(prior) return NextResponse.json({ok:true,already_resolved:true,company_id:ctx.companyId,company_name:companyName,mode:ctx.mode});
        const where=pk.map((c:any)=>`"${c.name}"=?`).join(' AND ');
        const old=d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...pk.map((c:any)=>key[c.name])) as any;
        const names=cols.map((c:any)=>String(c.name)).filter((n:string)=>Object.prototype.hasOwnProperty.call(row,n));
        if(!names.length) return NextResponse.json({error:'No compatible fields were provided.'},{status:400});
        const updates=names.filter((n:string)=>!pk.some((c:any)=>c.name===n)).map((n:string)=>`"${n}"=excluded."${n}"`).join(',');
        const sql=`INSERT INTO "${table}" (${names.map((n:string)=>`"${n}"`).join(',')}) VALUES (${names.map(()=>'?').join(',')}) ON CONFLICT (${pk.map((c:any)=>`"${c.name}"`).join(',')}) ${updates?`DO UPDATE SET ${updates}`:'DO NOTHING'}`;
        const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||ctx.deviceId);
        const tx=d.transaction(()=>{
          d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
          try { d.prepare(sql).run(...names.map((n:string)=>row[n]===undefined?null:row[n])); }
          finally { d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run(); }
          d.prepare('INSERT INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)').run(resolutionId,table,JSON.stringify(key),String(f.action||'push-source'),old?JSON.stringify(old):null,JSON.stringify(row),ctx.deviceId);
          const newEventId=crypto.randomUUID();
          d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(newEventId,table,JSON.stringify(key),old?'UPDATE':'INSERT',old?JSON.stringify(old):null,JSON.stringify(row),ownDevice);
        });
        try { tx(); } catch(err:any) { return NextResponse.json({error:err?.message||'Conflict resolution failed; no changes were committed.'},{status:409}); }
        return NextResponse.json({ok:true,resolved:true,mappings,destination_device_id:String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||ctx.deviceId),company_id:ctx.companyId,company_name:companyName,mode:ctx.mode});
      }
      const events=Array.isArray(body.events)?body.events:[];
      const peerMappings=Array.isArray(body.mappings)?body.mappings:[];
      if (!events.length && !peerMappings.length) { const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'remote-device'); return NextResponse.json({ok:true,applied:0,duplicates:0,mappings:[],destination_device_id:ownDevice}); }
      if (events.length>500) return NextResponse.json({error:'Maximum 500 events per batch.'},{status:413});
      const result:any={applied:0,duplicates:0,alreadyCurrent:0};
      const mappings:any[]=[];
      let activeEvent:any=null;
      const tx=d.transaction(()=>{
        importPeerMappings(d,peerMappings);
        const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'remote-device');
        for (const rawEvent of events) {
          activeEvent=rawEvent;
          const e=reconcileIncomingEvent(d,rawEvent,String(rawEvent?.origin_device||'unknown-device'),mappings);
          // A remapped row now has destination-local identity. Advertise it as a
          // destination-originated canonical event; the source has the inverse map.
          if (String(e.pk_json||'')!==String(rawEvent?.pk_json||'')) e.origin_device=ownDevice;
          const status=applyEvent(d,e,ctx.deviceId,companyName);
          if(status==='duplicate') result.duplicates++;
          else if(status==='already-current') result.alreadyCurrent++;
          else result.applied++;
        }
      });
      try { tx(); } catch(e:any) { return NextResponse.json({error:e?.message||'Sync batch rejected; no changes in this batch were committed.',conflict:true,conflict_phase:'push',conflict_event:activeEvent?{event_id:activeEvent.event_id,table_name:activeEvent.table_name,pk_json:activeEvent.pk_json,operation:activeEvent.operation,base_json:activeEvent.base_json,row_json:activeEvent.row_json}:null,conflict_detail:e?.conflictDetail||null},{status:409}); }
      const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'remote-device');
      return NextResponse.json({ok:true,...result,mappings,destination_device_id:ownDevice,company_id:ctx.companyId,company_name:companyName,mode:ctx.mode});
    }
    return NextResponse.json({error:'Method not allowed.'},{status:405});
  } catch(e:any) { return NextResponse.json({error:e?.message||'Sync exchange failed.'},{status:400}); }
}
const __wrapped_GET=withPostgresSQLiteBridge(handler);
const __wrapped_POST=withPostgresSQLiteBridge(handler);
export async function GET(req:Request){return __wrapped_GET(req);}
export async function POST(req:Request){return __wrapped_POST(req);}
