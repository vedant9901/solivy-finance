import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminDb, db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { reconcileIncomingEvent, storeInverseMappings, mappingsForPeer } from '../../../../lib/sync-id-mapping';
export const runtime = 'nodejs';
export const dynamic='force-dynamic';
const canon=(v:any):string=>v===null||v===undefined?'null':Array.isArray(v)?'['+v.map(canon).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);

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

const excluded=new Set(['sync_meta','sync_changes','sync_applied_events','sync_id_mappings','users','sqlite_sequence']);

function orderEventsByForeignKeys(d:any, events:any[]) {
  // Apply parent rows before dependent rows; delete dependent rows before parents.
  // Stable within each table so same-table event history is preserved.
  const tables=(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(x=>String(x.name));
  const deps=new Map<string,Set<string>>();
  for(const t of tables){
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
    try { const refs=d.prepare(`PRAGMA foreign_key_list("${t}")`).all() as any[]; deps.set(t,new Set(refs.map(r=>String(r.table)).filter(p=>p&&p!==t))); } catch { deps.set(t,new Set()); }
  }
  const memo=new Map<string,number>(); const visiting=new Set<string>();
  const rank=(t:string):number=>{ if(memo.has(t)) return memo.get(t)!; if(visiting.has(t)) return 0; visiting.add(t); let n=0; for(const p of deps.get(t)||[]) n=Math.max(n,rank(p)+1); visiting.delete(t); memo.set(t,n); return n; };
  for(const t of tables) rank(t);
  return events.map((e,i)=>({e,i})).sort((a,b)=>{
    const da=String(a.e?.operation||'').toUpperCase()==='DELETE', dbb=String(b.e?.operation||'').toUpperCase()==='DELETE';
    if(da!==dbb) return da?-1:1;
    const ra=rank(String(a.e?.table_name||'')), rb=rank(String(b.e?.table_name||''));
    if(ra!==rb) return da?rb-ra:ra-rb;
    return a.i-b.i;
  }).map(x=>x.e);
}
function describeForeignKeyFailure(d:any, event:any, error:any) {
  const message=String(error?.message||error||'Sync failed');
  if(!/foreign key constraint failed/i.test(message)) return message;
  const table=String(event?.table_name||'unknown');
  let refs:any[]=[]; try { if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) refs=d.prepare(`PRAGMA foreign_key_list("${table}")`).all(); } catch {}
  const pk=String(event?.pk_json||'');
  return `Foreign key constraint failed while syncing ${table} (operation ${String(event?.operation||'unknown')}, key ${pk||'unknown'}). Referenced tables: ${refs.map(r=>`${r.table}.${r.to||'id'} via ${r.from}`).join(', ')||'not discoverable from this table schema'}. The batch was rolled back; parent records must exist before dependent records.`;
}


function mergeInitialCompanySettings(current:any, incoming:any, cols:any[], companyName='') {
  const merged:any = {};
  const conflicts:any[] = [];
  const empty = (name:string, value:any) => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return true;
    if (name.endsWith('_settings') && typeof value === 'string') {
      try { const parsed=JSON.parse(value); if (parsed && typeof parsed==='object' && !Array.isArray(parsed) && Object.keys(parsed).length===0) return true; } catch { /* malformed settings are not empty */ }
    }
    return false;
  };
  const orgName=String(companyName||'').trim();
  for (const col of cols) {
    const name=String(col.name), a=current?.[name], b=incoming?.[name];
    if (Number(col.pk)>0) { merged[name]=a===undefined?b:a; continue; }
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

function applyLocal(d:any,e:any,companyName='') {
  if(d.prepare('SELECT event_id FROM sync_applied_events WHERE event_id=?').get(e.event_id)) return 'duplicate';
  const table=String(e.table_name||'');
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)||excluded.has(table)||table.startsWith('license_')||table.startsWith('admin_')) throw new Error('Unsupported table in downloaded sync event.');
  if(!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Unknown table in downloaded sync event: '+table);
  const cols=d.prepare(`PRAGMA table_info("${table}")`).all() as any[], pk=cols.filter((c:any)=>Number(c.pk)>0).sort((a:any,b:any)=>a.pk-b.pk);
  if(!pk.length) throw new Error('Table has no primary key: '+table);
  const key=JSON.parse(e.pk_json||'{}');
  if(!pk.every((c:any)=>Object.prototype.hasOwnProperty.call(key,c.name))) throw new Error('Invalid sync primary key.');
  const where=pk.map((c:any)=>`"${c.name}"=?`).join(' AND ');
  const current=d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...pk.map((c:any)=>key[c.name])) as any;
  const base=e.base_json?JSON.parse(e.base_json):null, row=e.row_json?JSON.parse(e.row_json):null;
  if(current&&row&&canon(current)===canon(row)) {
    d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
    d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(e.event_id,table,e.pk_json,e.operation,e.base_json,e.row_json,e.origin_device||'remote');
    return 'same';
  }
  if(base===null && current && table==='company_settings' && e.operation==='INSERT' && row && typeof row==='object') {
    const {merged,conflicts}=mergeInitialCompanySettings(current,row,cols,companyName);
    if(conflicts.length) throw Object.assign(new Error(`Conflict on company_settings: non-empty fields differ (${conflicts.map((x:any)=>x.field).join(', ')}). Review both versions.`), { conflictDetail: { table:'company_settings',primary_key:key,reason:'Initial company settings can be merged only when fields do not disagree. Review the listed fields before retrying.',field_conflicts:conflicts,base:null,current,incoming:row } });
    d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
    try {
      const names=cols.map((c:any)=>String(c.name)).filter((n:string)=>!pk.some((c:any)=>c.name===n));
      if(names.length)d.prepare(`UPDATE "company_settings" SET ${names.map((n:string)=>`"${n}"=?`).join(',')} WHERE ${where}`).run(...names.map((n:string)=>merged[n]===undefined?null:merged[n]),...pk.map((c:any)=>key[c.name]));
      d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
      d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(e.event_id,table,e.pk_json,e.operation,e.base_json,e.row_json,e.origin_device||'remote');
      const ownDevice=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'offline-device');
      d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,0)').run(crypto.randomUUID(),table,e.pk_json,'UPDATE',JSON.stringify(row),JSON.stringify(merged),ownDevice);
    } finally { d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run(); }
    return 'merged-settings';
  }
  let effectiveRow=row; let fieldConflicts:any[]=[];
  if(base===null && current && table!=='company_settings' && e.operation==='INSERT' && row && typeof row==='object') {
    // A true new-row PK collision should have been remapped by reconcileIncomingEvent. If it
    // still reaches here, do not overwrite the unrelated row or silently discard the insert.
    throw Object.assign(new Error(`Identity collision on ${table}; safe ID mapping is required before applying this insert.`), { conflictDetail: { table, primary_key:key, reason:'The source record has a colliding primary key and no safe mapping was supplied.', base:null, current, incoming:row } });
  } else if(base!==null && current && row && typeof row==='object' && canon(current)!==canon(base)) {
    const merged=mergeChangedFields(base,current,row,cols); effectiveRow=merged.merged; fieldConflicts=merged.conflicts;
    if(fieldConflicts.length){ ensureConflictHistory(d); const log=d.prepare('INSERT INTO sync_conflict_history(event_id,table_name,pk_json,field_name,base_value,local_value,incoming_value) VALUES(?,?,?,?,?,?,?)'); for(const c of fieldConflicts)log.run(String(e.event_id),table,JSON.stringify(key),c.field,JSON.stringify(c.base),JSON.stringify(c.local),JSON.stringify(c.incoming)); }
  } else if(base!==null && !current) {
    throw Object.assign(new Error(`Cannot merge ${table}: the base record was deleted locally.`), { conflictDetail: { table, primary_key:key, reason:'The record was deleted on this device while the other side edited it.', base, current:null, incoming:row } });
  }
  d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
  try {
    if(e.operation==='DELETE') { if(current)d.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...pk.map((c:any)=>key[c.name])); }
    else {
      if(!effectiveRow||typeof effectiveRow!=='object') throw new Error('Missing row data.');
      const names=cols.map((c:any)=>c.name).filter((n:string)=>Object.prototype.hasOwnProperty.call(effectiveRow,n));
      const conflict=pk.map((c:any)=>`"${c.name}"`).join(',');
      const updates=names.filter((n:string)=>!pk.some((c:any)=>c.name===n)).map((n:string)=>`"${n}"=excluded."${n}"`).join(',');
      d.prepare(`INSERT INTO "${table}" (${names.map((n:string)=>`"${n}"`).join(',')}) VALUES (${names.map(()=>'?').join(',')}) ON CONFLICT (${conflict}) ${updates?`DO UPDATE SET ${updates}`:'DO NOTHING'}`).run(...names.map((n:string)=>effectiveRow[n]===undefined?null:effectiveRow[n]));
    }
    d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
    d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(e.event_id,table,e.pk_json,e.operation,e.base_json,JSON.stringify(effectiveRow),e.origin_device||'remote');
    if(fieldConflicts.length){const own=String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id||'offline-device');d.prepare('INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,0)').run(crypto.randomUUID(),table,e.pk_json,'UPDATE',JSON.stringify(current),JSON.stringify(effectiveRow),own);}
  } finally { d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run(); }
  return 'applied';
}
function reserveOfflineIdRanges(d:any,deviceId:string) {
  // Give each independently-created offline database a disjoint AUTOINCREMENT
  // range. Existing IDs remain unchanged; new local IDs avoid the common 1,2,3
  // collisions that otherwise occur when two databases create records offline.
  let hash=2166136261;
  for (const ch of deviceId) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash,16777619)>>>0; }
  const prefix=(100000+(hash%800000))*1000000000;
  const tables=d.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql LIKE '%AUTOINCREMENT%' AND name NOT LIKE 'sqlite_%'").all() as any[];
  for (const t of tables) {
    if (excluded.has(t.name)||t.name.startsWith('license_')||t.name.startsWith('admin_')) continue;
    const exists=d.prepare("SELECT name FROM sqlite_sequence WHERE name=?").get(t.name);
    if (!exists) d.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(t.name,prefix);
    else d.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?').run(prefix,t.name);
  }
}
function safeRemote(raw:string) {
  const u=new URL(raw);
  if(u.username||u.password||u.search||u.hash) throw new Error('Remote URL must not contain credentials, query strings or fragments.');
  const local=['localhost','127.0.0.1','::1'].includes(u.hostname);
  if(u.protocol!=='https:' && !(local&&u.protocol==='http:')) throw new Error('Remote sync URL must use HTTPS.');
  return u.toString().replace(/\/+$/,'');
}
async function handler(req:Request) {
  try {
    const body=await req.json().catch(()=>({}));
    const remoteUrl=safeRemote(String(body.remote_url||''));
    const token=String(body.device_token||'');
    const remoteCompanyId=Number(body.remote_company_id||0);
    const localCompanyId=Number(req.headers.get('x-aksh-company-id')||0);
    const mode=req.headers.get('x-aksh-mode');
    if(!token||token.length>300||!remoteCompanyId||!localCompanyId||!['LIVE','TEST'].includes(String(mode))) return NextResponse.json({error:'Remote URL, pairing token, destination company and environment are required.'},{status:400});
    if(body.remote_mode && body.remote_mode!==mode) return NextResponse.json({error:'LIVE and TEST cannot sync across environments. Pair each environment separately.'},{status:400});
    const d=db(mode as Mode,localCompanyId);
    const localOrganization=adminDb().prepare('SELECT name FROM companies WHERE id=?').get(localCompanyId) as any;
    const localCompanyName=String(localOrganization?.name||'');
    const meta=d.prepare('SELECT device_id,remote_cursor,remote_device_id FROM sync_meta WHERE id=1').get() as any;
    const deviceId=String(meta.device_id);
    reserveOfflineIdRanges(d,deviceId);
    const headers={'content-type':'application/json','x-solivy-device-token':token,'x-solivy-device-id':deviceId,'x-aksh-company-id':String(remoteCompanyId),'x-aksh-mode':String(mode)};
    // Preflight the token-authorized destination BEFORE pushing any events. Company IDs
    // may differ between offline and online databases, but the selected organization must match.
    const preflight=await fetch(remoteUrl+'/api/sync/exchange?cursor=0&limit=1',{method:'GET',headers,cache:'no-store',signal:AbortSignal.timeout(12000)});
    const preflightData=await preflight.json().catch(()=>({}));
    if(!preflight.ok) return NextResponse.json({error:preflightData.error||`Remote authorization failed (${preflight.status}).`,http_status:preflight.status},{status:preflight.status===401||preflight.status===403?preflight.status:502});
    const remoteOrganizationName=String(preflightData.company_name||'').trim();
    if(!remoteOrganizationName || remoteOrganizationName.localeCompare(localCompanyName,undefined,{sensitivity:'accent'})!==0) {
      return NextResponse.json({error:`Sync blocked: selected offline company "${localCompanyName}" does not match the token-authorized online company "${remoteOrganizationName||'unknown'}". Select AKSH ENTERPRISE on both sides and use the token generated while AKSH ENTERPRISE (online company ID ${remoteCompanyId}) is selected. No sync changes were pushed.`},{status:409});
    }
    const pending=d.prepare('SELECT seq,event_id,table_name,pk_json,operation,base_json,row_json,origin_device,created_at FROM sync_changes WHERE pushed=0 ORDER BY seq LIMIT 500').all() as any[];
    // Include snapshots of referenced parent rows when an outgoing child event depends on a
    // parent that has no outgoing event in this batch. This repairs legacy/incomplete sync
    // histories (for example account_transactions.account_id -> company_accounts.id) without
    // disabling foreign keys or dropping the child transaction. The destination still runs its
    // normal ID-collision reconciliation and records mappings before applying dependent rows.
    const outgoingEvents:any[]=[...pending];
    // Explicitly recover company-account parents for bank-ledger events. Some older
    // installations recorded account_transactions changes without a corresponding
    // company_accounts sync event. Include the authoritative parent row from this
    // source database, then let destination ID reconciliation map account_id safely.
    // Never fabricate a company account: if it is absent locally, the preflight below
    // returns a precise error rather than disabling FK enforcement.
    const seenParents=new Set<string>();
    for (const e of pending) { try { const pk=JSON.parse(String(e.pk_json||'{}')); seenParents.add(String(e.table_name)+'|'+canon(pk)); } catch {} }
    const parentQueue:any[]=[...pending.filter((e:any)=>String(e.operation||'').toUpperCase()!=='DELETE' && e.row_json).map((e:any)=>({table:String(e.table_name),row:JSON.parse(String(e.row_json))}))];
    // Seed direct account_transactions -> company_accounts parents first. This avoids
    // a generic traversal limit starving a bank-account parent when a batch is large.
    for (const e of pending) {
      if (String(e.table_name)!=='account_transactions' || String(e.operation||'').toUpperCase()==='DELETE' || !e.row_json) continue;
      let child:any=null; try { child=JSON.parse(String(e.row_json)); } catch { continue; }
      const accountId=child?.account_id;
      if (accountId===null || accountId===undefined) continue;
      const parent=d.prepare('SELECT * FROM company_accounts WHERE id=?').get(accountId) as any;
      if (!parent) continue;
      const signature='company_accounts|'+canon({id:parent.id});
      if (seenParents.has(signature)) continue;
      seenParents.add(signature);
      outgoingEvents.push({seq:-1,event_id:crypto.randomUUID(),table_name:'company_accounts',pk_json:JSON.stringify({id:parent.id}),operation:'INSERT',base_json:null,row_json:JSON.stringify(parent),origin_device:deviceId,created_at:new Date().toISOString()});
      parentQueue.push({table:'company_accounts',row:parent});
    }
    let parentScan=0;
    while(parentQueue.length && parentScan++<2000 && outgoingEvents.length<700) {
      const item=parentQueue.shift();
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.table)) continue;
      let fks:any[]=[]; try { fks=d.prepare(`PRAGMA foreign_key_list("${item.table}")`).all() as any[]; } catch { continue; }
      for(const fk of fks) {
        const from=String(fk.from||''), parentTable=String(fk.table||''), to=String(fk.to||'id');
        if(!from || !parentTable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parentTable) || to!=='id') continue;
        const parentId=item.row?.[from]; if(parentId===null || parentId===undefined) continue;
        let parent:any=null; try { parent=d.prepare(`SELECT * FROM "${parentTable}" WHERE "${to}"=?`).get(parentId); } catch {}
        if(!parent) continue; // Do not fabricate a missing parent; destination will report the precise FK.
        const parentKey={id:parent[to]}; const signature=parentTable+'|'+canon(parentKey);
        if(seenParents.has(signature)) continue;
        seenParents.add(signature);
        const cols=d.prepare(`PRAGMA table_info("${parentTable}")`).all() as any[];
        const pks=cols.filter((c:any)=>Number(c.pk)>0);
        if(pks.length!==1 || String(pks[0].name)!==to) continue;
        const synthetic={seq:-1,event_id:crypto.randomUUID(),table_name:parentTable,pk_json:JSON.stringify(parentKey),operation:'INSERT',base_json:null,row_json:JSON.stringify(parent),origin_device:deviceId,created_at:new Date().toISOString()};
        outgoingEvents.push(synthetic);
        parentQueue.push({table:parentTable,row:parent});
        if(outgoingEvents.length>=700) break;
      }
    }
    const outgoingOrdered=orderEventsByForeignKeys(d,outgoingEvents);
    const outgoingMappings=meta.remote_device_id ? mappingsForPeer(d,String(meta.remote_device_id),deviceId) : [];
    let pushed=0;
    if(outgoingEvents.length || outgoingMappings.length) {
      const resp=await fetch(remoteUrl+'/api/sync/exchange',{method:'POST',headers,body:JSON.stringify({events:outgoingOrdered,mappings:outgoingMappings}),cache:'no-store'});
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) return NextResponse.json({error:data.error||`Remote push failed (${resp.status}).`,conflict:resp.status===409,conflict_detail:data.conflict_detail||null,conflict_event:data.conflict_event||null,conflict_phase:data.conflict_phase||'push',pending:pending.length},{status:resp.status===409?409:502});
      if (Array.isArray(data.mappings)) storeInverseMappings(d,data.mappings,String(data.destination_device_id||'remote-device'));
      if (data.destination_device_id) d.prepare('UPDATE sync_meta SET remote_device_id=? WHERE id=1').run(String(data.destination_device_id));
      const ids=pending.map(e=>e.event_id);
      const mark=d.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?');
      const tx=d.transaction(()=>{for(const id of ids)mark.run(id)});tx();
      pushed=pending.length;
    }
    const pullUrl=remoteUrl+'/api/sync/exchange?cursor='+encodeURIComponent(String(meta.remote_cursor||0))+'&limit=500';
    const pull=await fetch(pullUrl,{method:'GET',headers,cache:'no-store'});
    const pulled=await pull.json().catch(()=>({}));
    if(!pull.ok) return NextResponse.json({error:pulled.error||`Remote pull failed (${pull.status}).`,pushed},{status:502});
    if (pulled.destination_device_id) { d.prepare('UPDATE sync_meta SET remote_device_id=? WHERE id=1').run(String(pulled.destination_device_id)); }
    const events=orderEventsByForeignKeys(d,Array.isArray(pulled.events)?pulled.events:[]);
    const summary={applied:0,duplicates:0,unchanged:0};
    const localMappings:any[]=[];
    let activePullEvent:any=null;
    try {
      const tx=d.transaction(()=>{
        for(const rawEvent of events) {
          activePullEvent=rawEvent;
          const e=reconcileIncomingEvent(d,rawEvent,String(rawEvent?.origin_device||meta.remote_device_id||'remote-device'),localMappings);
          const status=applyLocal(d,e,localCompanyName);
          if(status==='duplicate')summary.duplicates++;else if(status==='same')summary.unchanged++;else summary.applied++;
        }
        d.prepare('UPDATE sync_meta SET remote_cursor=?,last_sync_at=CURRENT_TIMESTAMP,paired_url=?,paired_company_id=?,sync_mode=?,remote_device_id=? WHERE id=1')
          .run(Number(pulled.cursor||meta.remote_cursor||0),remoteUrl,remoteCompanyId,mode,String(pulled.destination_device_id||meta.remote_device_id||'remote-device'));
      });
      tx();
    } catch(e:any) {
      return NextResponse.json({error:describeForeignKeyFailure(d,activePullEvent,e)||'Local apply failed; downloaded batch was not committed.',conflict:true,conflict_phase:'pull',conflict_event:activePullEvent?{event_id:activePullEvent.event_id,table_name:activePullEvent.table_name,pk_json:activePullEvent.pk_json,operation:activePullEvent.operation,base_json:activePullEvent.base_json,row_json:activePullEvent.row_json}:null,conflict_detail:e?.conflictDetail||null,pushed,pending_downloads:events.length,remote_cursor:Number(pulled.cursor||meta.remote_cursor||0)},{status:409});
    }
    return NextResponse.json({ok:true,mode,local_company_id:localCompanyId,remote_company_id:remoteCompanyId,pushed,pulled:events.length,...summary,id_mappings_created:localMappings.length,last_sync_at:new Date().toISOString(),has_more:Boolean(pulled.has_more)});
  } catch(e:any) { return NextResponse.json({error:e?.message||'Sync failed.'},{status:400}); }
}
const __wrapped_POST=withPostgresSQLiteBridge(handler);
export async function POST(req:Request){return __wrapped_POST(req);}
