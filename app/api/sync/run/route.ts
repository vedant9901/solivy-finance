import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminDb, db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { pruneSyncJournal } from '../../../../lib/sync-prune';
import { reconcileIncomingEvent, storeInverseMappings, mappingsForPeer } from '../../../../lib/sync-id-mapping';
import { SYNC_EXCLUDED_TABLES } from '../../../../lib/sync-eligibility';
import { recordReject, recordObsolete, openRejectCount, newCorrelationId, clearReject } from '../../../../lib/sync-quarantine';
export const runtime = 'nodejs';
export const dynamic='force-dynamic';
import { canon, applyLocal } from '../../../../lib/sync-apply';


// v2.8.1: shared with the hub and the trigger builder (lib/sync-eligibility.ts). This copy
// previously omitted login_attempts, sync_resolution_log and sync_conflict_history, so the two
// sides disagreed about what may be synchronised at all.
const excluded=SYNC_EXCLUDED_TABLES;

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
    // One correlation id per run, carried on every request and returned to the caller, so a
    // rejection can be traced across both sides. It is random and identifies nothing else.
    const correlationId=newCorrelationId();
    const headers={'content-type':'application/json','x-solivy-device-token':token,'x-solivy-device-id':deviceId,'x-aksh-company-id':String(remoteCompanyId),'x-aksh-mode':String(mode),'x-solivy-sync-correlation':correlationId};
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
    let pushed=0; let remoteFieldConflicts=0; let pushRejected:any[]=[];
    if(outgoingEvents.length || outgoingMappings.length) {
      const resp=await fetch(remoteUrl+'/api/sync/exchange',{method:'POST',headers,body:JSON.stringify({events:outgoingOrdered,mappings:outgoingMappings}),cache:'no-store'});
      const data=await resp.json().catch(()=>({}));
      remoteFieldConflicts=Number(data?.field_conflicts||0);
      if(Array.isArray(data.rejected)) for(const r of data.rejected){ const src=outgoingOrdered.find((x:any)=>String(x.event_id)===String(r.event_id)); try{ recordReject(d,{phase:'push',event:src||{event_id:r.event_id,table_name:r.table,pk_json:JSON.stringify(r.primary_key||{}),operation:r.operation},code:String(r.code||'CONFLICT'),reason:String(r.reason||'Rejected by the destination.'),detail:r.detail||null,correlationId}); }catch(err){ console.error('SOLIVY sync reject record failed',(err as any)?.message||err); } }
      if(!resp.ok) {
        // The destination could apply nothing in this batch. The per-item detail is still
        // reported (and quarantined above), so the caller can act on the blocking record
        // instead of seeing one unattributed message.
        const rejectedNow=Array.isArray(data.rejected)&&data.rejected.length?data.rejected:(data.conflict_detail||data.conflict_event?[{event_id:String(data.conflict_event?.event_id||''),table:String(data.conflict_detail?.table||data.conflict_event?.table_name||''),primary_key:data.conflict_detail?.primary_key||null,operation:String(data.conflict_event?.operation||''),code:String(data.conflict_detail?.code||'CONFLICT'),reason:String(data.error||'Rejected by the destination.'),detail:data.conflict_detail||null}]:[]);
        if(!Array.isArray(data.rejected)) for(const r of rejectedNow){ const src=outgoingOrdered.find((x:any)=>String(x.event_id)===String(r.event_id)); try{ recordReject(d,{phase:'push',event:src||{event_id:r.event_id||('push-'+correlationId),table_name:r.table,pk_json:JSON.stringify(r.primary_key||{}),operation:r.operation},code:r.code,reason:r.reason,detail:r.detail,correlationId}); }catch(err){ console.error('SOLIVY sync reject record failed',(err as any)?.message||err); } }
        return NextResponse.json({error:data.error||`Remote push failed (${resp.status}).`,conflict:resp.status===409,conflict_detail:data.conflict_detail||rejectedNow[0]?.detail||null,conflict_event:data.conflict_event||null,conflict_phase:data.conflict_phase||'push',pending:pending.length,rejected:rejectedNow,rejected_count:rejectedNow.length,correlation_id:correlationId,open_rejects:openRejectCount(d)},{status:resp.status===409?409:502});
      }
      if (Array.isArray(data.mappings)) storeInverseMappings(d,data.mappings,String(data.destination_device_id||'remote-device'));
      if (data.destination_device_id) d.prepare('UPDATE sync_meta SET remote_device_id=? WHERE id=1').run(String(data.destination_device_id));
      // v2.8.1: mark only what the destination actually accepted. Before this the whole pending
      // batch was marked pushed on a 200 (which was safe only because the hub was all-or-nothing)
      // and nothing at all was marked on a 409, so one unapplicable item kept the entire queue
      // stuck. A rejected item stays pushed=0 and is therefore retried after its resolution.
      const acceptedIds=Array.isArray(data.accepted_event_ids)?new Set(data.accepted_event_ids.map((x:any)=>String(x))):null;
      const ids=pending.map(e=>String(e.event_id)).filter(id=>!acceptedIds||acceptedIds.has(id));
      const mark=d.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?');
      // An item the destination has now accepted is no longer blocked: close its quarantine entry.
      const tx=d.transaction(()=>{for(const id of ids){mark.run(id);clearReject(d,id);}});tx();
      pushed=ids.length;
      pushRejected=Array.isArray(data.rejected)?data.rejected:[];
    }
    const pullUrl=remoteUrl+'/api/sync/exchange?cursor='+encodeURIComponent(String(meta.remote_cursor||0))+'&limit=500';
    const pull=await fetch(pullUrl,{method:'GET',headers,cache:'no-store'});
    const pulled=await pull.json().catch(()=>({}));
    if(!pull.ok) return NextResponse.json({error:pulled.error||`Remote pull failed (${pull.status}).`,pushed},{status:502});
    if (pulled.destination_device_id) { d.prepare('UPDATE sync_meta SET remote_device_id=? WHERE id=1').run(String(pulled.destination_device_id)); }
    const events=orderEventsByForeignKeys(d,Array.isArray(pulled.events)?pulled.events:[]);
    const summary={applied:0,duplicates:0,unchanged:0,obsolete:0};
    const localMappings:any[]=[];
    // v2.8.1: per-item apply. The pull used to run the whole downloaded batch in one
    // transaction, so a single unapplicable event discarded the batch AND left the cursor
    // unmoved — the same events were downloaded and failed again on every subsequent attempt.
    // Each event now commits on its own; one that cannot be applied is stored in full in the
    // quarantine (lib/sync-quarantine.ts) and replayed from there by the retry path, so the
    // cursor can advance without losing the change.
    const pullRejected:any[]=[];
    for(const rawEvent of events) {
      try {
        const applyOne=d.transaction(()=>{
          const e=reconcileIncomingEvent(d,rawEvent,String(rawEvent?.origin_device||meta.remote_device_id||'remote-device'),localMappings);
          return applyLocal(d,e,localCompanyName);
        });
        const status=applyOne();
        if(status==='duplicate')summary.duplicates++;else if(status==='same')summary.unchanged++;else summary.applied++;
        clearReject(d,String(rawEvent?.event_id||''));
      } catch(err:any) {
        const code=String(err?.syncCode||err?.conflictDetail?.code||(/foreign key constraint failed/i.test(String(err?.message||''))?'FOREIGN_KEY':'CONFLICT'));
        const reason=describeForeignKeyFailure(d,rawEvent,err)||String(err?.message||'Could not be applied on this device.');
        if(code==='LOCAL_ONLY'||code==='DELETED_HERE') {
          recordObsolete(d,{phase:'pull',event:rawEvent,code,reason,detail:err?.conflictDetail||null,correlationId});
          try { d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(String(rawEvent?.event_id||'')); } catch {}
          summary.obsolete++;
          continue;
        }
        pullRejected.push(recordReject(d,{phase:'pull',event:rawEvent,code,reason,detail:err?.conflictDetail||null,correlationId}));
      }
    }
    d.prepare('UPDATE sync_meta SET remote_cursor=?,last_sync_at=CURRENT_TIMESTAMP,paired_url=?,paired_company_id=?,sync_mode=?,remote_device_id=? WHERE id=1')
      .run(Number(pulled.cursor||meta.remote_cursor||0),remoteUrl,remoteCompanyId,mode,String(pulled.destination_device_id||meta.remote_device_id||'remote-device'));
    const conflicts=[...pushRejected.map((r:any)=>({...r,phase:'push'})),...pullRejected];
    const first=conflicts[0]||null;
    let fieldConflictsRecorded=0;try{fieldConflictsRecorded=Number((d.prepare("SELECT COUNT(*) c FROM sync_conflict_history WHERE created_at>=datetime('now','-5 minutes')").get() as any)?.c||0)}catch{}
    let pruned:any=null;try{pruned=pruneSyncJournal(d)}catch(e){console.error('SOLIVY sync prune failed',e)}
    const body2:any={ok:conflicts.length===0,pruned,field_conflicts_recorded:fieldConflictsRecorded,remote_field_conflicts:remoteFieldConflicts,mode,local_company_id:localCompanyId,remote_company_id:remoteCompanyId,pushed,pulled:events.length,...summary,id_mappings_created:localMappings.length,last_sync_at:new Date().toISOString(),has_more:Boolean(pulled.has_more),correlation_id:correlationId,rejected:conflicts,rejected_count:conflicts.length,open_rejects:openRejectCount(d)};
    if(first){ body2.conflict=true; body2.conflict_phase=first.phase||'pull'; body2.error=first.reason; body2.conflict_detail=first.detail||{table:first.table,primary_key:first.primary_key,reason:first.reason,code:first.code};
      const src=events.find((x:any)=>String(x?.event_id||'')===String(first.event_id))||outgoingOrdered.find((x:any)=>String(x?.event_id||'')===String(first.event_id));
      body2.conflict_event=src?{event_id:src.event_id,table_name:src.table_name,pk_json:src.pk_json,operation:src.operation,base_json:src.base_json,row_json:src.row_json}:null; }
    return NextResponse.json(body2);
  } catch(e:any) { return NextResponse.json({error:e?.message||'Sync failed.'},{status:400}); }
}
const __wrapped_POST=withPostgresSQLiteBridge(handler,{noRetry:true,audit:false});
export async function POST(req:Request){return __wrapped_POST(req);}
