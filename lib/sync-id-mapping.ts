/** Persistent identity mapping for independently-created offline/online records. */
export const SYNC_ID_MAP_TABLE = 'sync_id_mappings';
const canon = (v:any):string => {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '['+v.map(canon).join(',')+']';
  if (typeof v === 'object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
  return JSON.stringify(v);
};
function parseJson(value:any) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function mapLookup(d:any, sourceDevice:string, table:string, sourcePk:any) {
  return d.prepare('SELECT destination_pk_json FROM sync_id_mappings WHERE source_device_id=? AND table_name=? AND source_pk_json=?')
    .get(sourceDevice,table,canon(sourcePk)) as any;
}
function saveMap(d:any, sourceDevice:string, table:string, sourcePk:any, destinationPk:any) {
  d.prepare('INSERT INTO sync_id_mappings(source_device_id,table_name,source_pk_json,destination_pk_json) VALUES(?,?,?,?) ON CONFLICT(source_device_id,table_name,source_pk_json) DO UPDATE SET destination_pk_json=excluded.destination_pk_json')
    .run(sourceDevice,table,canon(sourcePk),canon(destinationPk));
}
function rewriteKey(obj:any, oldKey:any, newKey:any) {
  if (!obj || typeof obj !== 'object') return obj;
  const out={...obj};
  for (const k of Object.keys(oldKey)) if (Object.prototype.hasOwnProperty.call(newKey,k)) out[k]=newKey[k];
  return out;
}
function remapForeignKeys(d:any, table:string, sourceDevice:string, row:any) {
  if (!row || typeof row !== 'object') return row;
  const out={...row};
  const fks=d.prepare(`PRAGMA foreign_key_list("${table}")`).all() as any[];
  for (const fk of fks) {
    const from=String(fk.from||''), target=String(fk.table||''), to=String(fk.to||'id');
    if (!from || !Object.prototype.hasOwnProperty.call(out,from) || out[from]===null || to!=='id') continue;
    const mapped=mapLookup(d,sourceDevice,target,{id:out[from]});
    if (!mapped) continue;
    const targetPk=parseJson(mapped.destination_pk_json);
    if (targetPk && Object.prototype.hasOwnProperty.call(targetPk,'id')) out[from]=targetPk.id;
  }
  return out;
}
/** Tables whose schema enforces a fixed singleton key (for example company_settings CHECK(id=1))
 * represent one row per organization, not independently-created entities. Never allocate a new ID
 * for these tables: doing so violates the schema and can abort an entire sync batch.
 */
function fixedSingletonId(d:any, table:string, pk:any[]):number|null {
  if (pk.length !== 1 || String(pk[0]?.name) !== 'id') return null;
  const schema=d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as any;
  const sql=String(schema?.sql||'');
  if (/CHECK\s*\(\s*[\"`\[]?id[\"`\]]?\s*=\s*1\s*\)/i.test(sql)) return 1;
  return null;
}

function nextIntegerId(d:any, table:string):number {
  const row=d.prepare(`SELECT COALESCE(MAX(CAST(id AS INTEGER)),0) AS max_id FROM "${table}"`).get() as any;
  let next=Number(row?.max_id||0)+1;
  try {
    const seq=d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table) as any;
    next=Math.max(next,Number(seq?.seq||0)+1);
  } catch { /* table may not use AUTOINCREMENT */ }
  return next;
}
/**
 * Reconcile a remote event against a destination database. A primary-key collision
 * on an INSERT is assigned a new destination id only when the table has a single
 * integer `id` primary key. Existing records are never overwritten. The source->
 * destination mapping is persisted and used for later updates and declared FKs.
 */
export function reconcileIncomingEvent(d:any, raw:any, sourceDeviceRaw:string, mappingsOut:any[] = []) {
  const e={...raw};
  const sourceDevice=String(sourceDeviceRaw||e.origin_device||'unknown-device');
  const table=String(e.table_name||'');
  const cols=d.prepare(`PRAGMA table_info("${table}")`).all() as any[];
  const pk=cols.filter((c:any)=>Number(c.pk)>0).sort((a:any,b:any)=>a.pk-b.pk);
  if (!pk.length) return e;
  const sourcePk=parseJson(e.pk_json)||{};
  const fixedId=fixedSingletonId(d,table,pk);
  if (fixedId !== null) {
    // Normalize the singleton key to its schema-required value. Do not persist an ID mapping
    // for singleton settings rows: both organizations have their own row id=1.
    const normalized={...sourcePk,id:fixedId};
    e.pk_json=JSON.stringify(normalized);
    for (const field of ['row_json','base_json']) {
      const parsed=parseJson((e as any)[field]);
      if (parsed && typeof parsed==='object') (e as any)[field]=JSON.stringify({...parsed,id:fixedId});
    }
    return e;
  }
  const existingMap=mapLookup(d,sourceDevice,table,sourcePk);
  let destinationPk=existingMap?parseJson(existingMap.destination_pk_json):null;
  if (destinationPk) {
    e.pk_json=JSON.stringify(destinationPk);
    if (e.row_json) e.row_json=JSON.stringify(rewriteKey(parseJson(e.row_json),sourcePk,destinationPk));
    if (e.base_json) e.base_json=JSON.stringify(rewriteKey(parseJson(e.base_json),sourcePk,destinationPk));
  }
  let row=parseJson(e.row_json), base=parseJson(e.base_json);
  row=remapForeignKeys(d,table,sourceDevice,row);
  base=remapForeignKeys(d,table,sourceDevice,base);
  if (row) e.row_json=JSON.stringify(row);
  if (base) e.base_json=JSON.stringify(base);
  const key=parseJson(e.pk_json)||sourcePk;
  const where=pk.map((c:any)=>`"${c.name}"=?`).join(' AND ');
  let current=d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...pk.map((c:any)=>key[c.name])) as any;
  if (!destinationPk && e.operation==='INSERT' && e.base_json==null && current && row && pk.length===1 && pk[0].name==='id' && /INT/i.test(String(pk[0].type||''))) {
    // If this exact row already exists, map to it. Otherwise preserve both records.
    const withoutVolatile=(x:any)=>{if(!x||typeof x!=='object')return x;const y={...x};delete y.created_at;delete y.updated_at;return y;};
    if (canon(withoutVolatile(current))===canon(withoutVolatile(row))) {
      destinationPk={id:current.id};
    } else {
      destinationPk={id:nextIntegerId(d,table)};
    }
    saveMap(d,sourceDevice,table,sourcePk,destinationPk);
    mappingsOut.push({source_device_id:sourceDevice,table_name:table,source_pk_json:canon(sourcePk),destination_pk_json:canon(destinationPk)});
    e.pk_json=JSON.stringify(destinationPk);
    row={...row,id:destinationPk.id};
    e.row_json=JSON.stringify(row);
    current=d.prepare(`SELECT * FROM "${table}" WHERE "id"=?`).get(destinationPk.id) as any;
  }
  return e;
}
/** Store the inverse map on the source device so events from the remote peer resolve back to local IDs. */
export function storeInverseMappings(d:any, mappings:any[], remoteDeviceId:string) {
  for (const m of mappings||[]) {
    if (!m || typeof m.table_name!=='string') continue;
    const sourcePk=parseJson(m.source_pk_json), destinationPk=parseJson(m.destination_pk_json);
    if (!sourcePk || !destinationPk) continue;
    saveMap(d,String(remoteDeviceId||m.source_device_id||'remote-device'),m.table_name,destinationPk,sourcePk);
  }
}

/** Import mappings asserted by the authenticated paired device. */
export function importPeerMappings(d:any, mappings:any[]) {
  for (const m of mappings||[]) {
    if (!m || typeof m.source_device_id!=='string' || typeof m.table_name!=='string' || m.source_device_id.length>100 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.table_name)) continue;
    const sourcePk=parseJson(m.source_pk_json), destinationPk=parseJson(m.destination_pk_json);
    if (!sourcePk || !destinationPk || typeof sourcePk!=='object' || typeof destinationPk!=='object') continue;
    saveMap(d,m.source_device_id,m.table_name,sourcePk,destinationPk);
  }
}
export function mappingsForPeer(d:any, peerDeviceId:string, localDeviceId:string) {
  const rows=d.prepare('SELECT table_name,source_pk_json,destination_pk_json FROM sync_id_mappings WHERE source_device_id=?').all(peerDeviceId) as any[];
  return rows.map(m=>({source_device_id:localDeviceId,table_name:m.table_name,source_pk_json:m.destination_pk_json,destination_pk_json:m.source_pk_json}));
}
