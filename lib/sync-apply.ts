import crypto from 'node:crypto';
import { syncTableInfo } from './sync-eligibility';
import { decideAbsent } from './sync-absent';
import { FINANCIAL_SYNC_TABLES, financialConflictError } from './sync-policy';
import { postedGuard, staleDeleteGuard } from './sync-delete';
import { referencesTo, describeReferences, softDeleteColumn } from './sync-fk';

/**
 * Applying one incoming sync event to a local SQLite database (v2.8.2).
 *
 * Moved out of `app/api/sync/run/route.ts` unchanged. The quarantine retry path
 * (`/api/sync/rejects`) replays a stored event through exactly this function; importing it from a
 * library rather than from another route module keeps route files independent of one another, which
 * is what a build packages and serves.
 */
export const canon=(v:any):string=>v===null||v===undefined?'null':Array.isArray(v)?'['+v.map(canon).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);

export function mergeChangedFields(base:any, current:any, incoming:any, cols:any[]) {
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
export function ensureConflictHistory(d:any) {
  d.exec("CREATE TABLE IF NOT EXISTS sync_conflict_history (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, field_name TEXT NOT NULL, base_value TEXT, local_value TEXT, incoming_value TEXT, resolution TEXT NOT NULL DEFAULT 'kept_local_audit_both', created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
}

export function mergeInitialCompanySettings(current:any, incoming:any, cols:any[], companyName='') {
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

export function applyLocal(d:any,e:any,companyName='') {
  if(d.prepare('SELECT event_id FROM sync_applied_events WHERE event_id=?').get(e.event_id)) return 'duplicate';
  const table=String(e.table_name||'');
  const info=syncTableInfo(d,table);
  if(!info.ok) throw Object.assign(new Error(info.message),{syncCode:info.code,conflictDetail:{table,reason:info.message,code:info.code}});
  const cols=info.cols, pk=info.pk;
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
    if(fieldConflicts.length&&FINANCIAL_SYNC_TABLES.has(String(table)))throw financialConflictError(String(table),key,base,current,row,fieldConflicts);
    if(fieldConflicts.length){ ensureConflictHistory(d); const log=d.prepare('INSERT INTO sync_conflict_history(event_id,table_name,pk_json,field_name,base_value,local_value,incoming_value) VALUES(?,?,?,?,?,?,?)'); for(const c of fieldConflicts)log.run(String(e.event_id),table,JSON.stringify(key),c.field,JSON.stringify(c.base),JSON.stringify(c.local),JSON.stringify(c.incoming)); }
  } else if(!current) {
    // v2.8.1: deterministic, explained outcome per operation (see lib/sync-absent.ts). A DELETE
    // whose record is already gone is agreement, not a conflict.
    const decision=decideAbsent(d,{table_name:table,pk_json:String(e.pk_json||''),operation:String(e.operation||'')},base);
    if(decision.kind==='noop') {
      d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
      d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)').run(e.event_id,table,e.pk_json,e.operation,e.base_json,e.row_json,e.origin_device||'remote');
      return 'same';
    }
    if(decision.kind==='obsolete') throw Object.assign(new Error(decision.reason),{syncCode:decision.code,conflictDetail:{table,primary_key:key,reason:decision.reason,base,current:null,incoming:row,operation:String(e.operation||''),code:decision.code}});
    effectiveRow=row;
  }
  d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
  try {
    if(e.operation==='DELETE') {
      // v2.8.3: the device side applied a deletion with no guard at all, so a record that other
      // rows still referenced produced a bare "FOREIGN KEY constraint failed" with no indication
      // of what blocked it (the reported `parties · DELETE · id 15`). The hub's guards now apply
      // here too: a POSTED financial record is never deleted, a stale deletion cannot discard a
      // newer record, and a still-referenced record raises a conflict that names the blocking
      // tables and record ids instead of a database error.
      if(current) {
        const posted=postedGuard(table,current);
        if(!posted.ok) { d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run(); throw Object.assign(new Error(posted.message),{syncCode:posted.code,conflictDetail:{table,primary_key:key,reason:posted.message,base,current,incoming:null,operation:'DELETE',code:posted.code}}); }
        if(FINANCIAL_SYNC_TABLES.has(table)) {
          const stale=staleDeleteGuard(current,base);
          if(!stale.ok) { d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run(); throw Object.assign(new Error(`Cannot delete ${table}: ${stale.message}`),{syncCode:stale.code,conflictDetail:{table,primary_key:key,reason:stale.message,base,current,incoming:null,operation:'DELETE',code:stale.code}}); }
        }
        const refs=referencesTo(d,table,key);
        if(refs.length) {
          d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run();
          const soft=softDeleteColumn(d,table);
          const message=`Cannot delete ${table.replace(/_/g,' ')} ${JSON.stringify(key)} on this device: it is still referenced by ${describeReferences(refs).join('; ')}.${soft?` Financial history must be preserved, so deactivate this record (${soft}=0) instead of deleting it, or resolve the referencing records first.`:' Resolve or remove the referencing records first.'} Nothing was deleted and the item stays retryable.`;
          throw Object.assign(new Error(message),{syncCode:'HAS_DEPENDENTS',conflictDetail:{table,primary_key:key,reason:message,base,current,incoming:null,operation:'DELETE',code:'HAS_DEPENDENTS',dependents:refs.map(r=>({table:r.table,count:r.count,column:r.column,ids:r.ids,declared:r.declared})),soft_delete_column:soft}});
        }
        d.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...pk.map((c:any)=>key[c.name]));
      }
    }
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
