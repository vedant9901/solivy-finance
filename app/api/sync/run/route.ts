<<<<<<< HEAD
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { db, type Mode } from "../../../../lib/db";
import { withPostgresSQLiteBridge } from "../../../../lib/postgres-sqlite-bridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const canon = (v: any): string =>
  v === null || v === undefined
    ? "null"
    : Array.isArray(v)
      ? "[" + v.map(canon).join(",") + "]"
      : typeof v === "object"
        ? "{" +
          Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
            .join(",") +
          "}"
        : JSON.stringify(v);
const excluded = new Set(["sync_meta", "sync_changes", "sync_applied_events", "users", "sqlite_sequence"]);

function mergeInitialCompanySettings(current: any, incoming: any, cols: any[]) {
  const merged: any = {};
  const conflicts: any[] = [];
  const empty = (v: any) => v === null || v === undefined || v === "";
  for (const col of cols) {
    const name = String(col.name),
      a = current?.[name],
      b = incoming?.[name];
    if (Number(col.pk) > 0) {
      merged[name] = a === undefined ? b : a;
      continue;
=======
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
export const runtime = 'nodejs';
export const dynamic='force-dynamic';
const canon=(v:any):string=>v===null||v===undefined?'null':Array.isArray(v)?'['+v.map(canon).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const excluded=new Set(['sync_meta','sync_changes','sync_applied_events','users','sqlite_sequence']);

function mergeInitialCompanySettings(current:any, incoming:any, cols:any[]) {
  const merged:any = {};
  const conflicts:any[] = [];
  const empty = (v:any) => v === null || v === undefined || v === '';
  for (const col of cols) {
    const name=String(col.name), a=current?.[name], b=incoming?.[name];
    if (Number(col.pk)>0) { merged[name]=a===undefined?b:a; continue; }
    if (canon(a)===canon(b)) { merged[name]=a; continue; }
    if (name==='updated_at' && !empty(a) && !empty(b)) { merged[name]=String(a)>=String(b)?a:b; continue; }
    if (name==='created_at' && !empty(a) && !empty(b)) { merged[name]=String(a)<=String(b)?a:b; continue; }
    if (empty(a)) { merged[name]=b; continue; }
    if (empty(b)) { merged[name]=a; continue; }
    conflicts.push({field:name,existing:a,incoming:b});
    merged[name]=a;
  }
  return {merged,conflicts};
}

function applyLocal(d:any,e:any) {
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
    const {merged,conflicts}=mergeInitialCompanySettings(current,row,cols);
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
  if(base===null) { if(current) throw Object.assign(new Error(`Conflict on ${table}: record already exists.`), { conflictDetail: { table, primary_key: key, reason: 'A record with this key already exists on this device.', base: null, current, incoming: row } }); }
  else if(!current||canon(current)!==canon(base)) throw Object.assign(new Error(`Conflict on ${table}: record changed locally.`), { conflictDetail: { table, primary_key: key, reason: 'This device record differs from the version last seen by the other device.', base, current: current || null, incoming: row } });
  d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
  try {
    if(e.operation==='DELETE') { if(current)d.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...pk.map((c:any)=>key[c.name])); }
    else {
      if(!row||typeof row!=='object') throw new Error('Missing row data.');
      const names=cols.map((c:any)=>c.name).filter((n:string)=>Object.prototype.hasOwnProperty.call(row,n));
      const conflict=pk.map((c:any)=>`"${c.name}"`).join(',');
      const updates=names.filter((n:string)=>!pk.some((c:any)=>c.name===n)).map((n:string)=>`"${n}"=excluded."${n}"`).join(',');
      d.prepare(`INSERT INTO "${table}" (${names.map((n:string)=>`"${n}"`).join(',')}) VALUES (${names.map(()=>'?').join(',')}) ON CONFLICT (${conflict}) ${updates?`DO UPDATE SET ${updates}`:'DO NOTHING'}`).run(...names.map((n:string)=>row[n]===undefined?null:row[n]));
>>>>>>> 3cf4b25 (new update)
    }
    if (canon(a) === canon(b)) {
      merged[name] = a;
      continue;
    }
    if (name === "updated_at" && !empty(a) && !empty(b)) {
      merged[name] = String(a) >= String(b) ? a : b;
      continue;
    }
    if (name === "created_at" && !empty(a) && !empty(b)) {
      merged[name] = String(a) <= String(b) ? a : b;
      continue;
    }
    if (empty(a)) {
      merged[name] = b;
      continue;
    }
    if (empty(b)) {
      merged[name] = a;
      continue;
    }
    conflicts.push({ field: name, existing: a, incoming: b });
    merged[name] = a;
  }
  return { merged, conflicts };
}

function applyLocal(d: any, e: any) {
  if (d.prepare("SELECT event_id FROM sync_applied_events WHERE event_id=?").get(e.event_id)) return "duplicate";
  const table = String(e.table_name || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || excluded.has(table) || table.startsWith("license_") || table.startsWith("admin_")) throw new Error("Unsupported table in downloaded sync event.");
  if (!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error("Unknown table in downloaded sync event: " + table);
  const cols = d.prepare(`PRAGMA table_info("${table}")`).all() as any[],
    pk = cols.filter((c: any) => Number(c.pk) > 0).sort((a: any, b: any) => a.pk - b.pk);
  if (!pk.length) throw new Error("Table has no primary key: " + table);
  const key = JSON.parse(e.pk_json || "{}");
  if (!pk.every((c: any) => Object.prototype.hasOwnProperty.call(key, c.name))) throw new Error("Invalid sync primary key.");
  const where = pk.map((c: any) => `"${c.name}"=?`).join(" AND ");
  const current = d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...pk.map((c: any) => key[c.name])) as any;
  const base = e.base_json ? JSON.parse(e.base_json) : null,
    row = e.row_json ? JSON.parse(e.row_json) : null;
  if (current && row && canon(current) === canon(row)) {
    d.prepare("INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)").run(e.event_id);
    d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
      e.event_id,
      table,
      e.pk_json,
      e.operation,
      e.base_json,
      e.row_json,
      e.origin_device || "remote",
    );
    return "same";
  }
  if (base === null && current && table === "company_settings" && e.operation === "INSERT" && row && typeof row === "object") {
    const { merged, conflicts } = mergeInitialCompanySettings(current, row, cols);
    if (conflicts.length)
      throw Object.assign(new Error(`Conflict on company_settings: non-empty fields differ (${conflicts.map((x: any) => x.field).join(", ")}). Review both versions.`), {
        conflictDetail: {
          table: "company_settings",
          primary_key: key,
          reason: "Initial company settings can be merged only when fields do not disagree. Review the listed fields before retrying.",
          field_conflicts: conflicts,
          base: null,
          current,
          incoming: row,
        },
      });
    d.prepare("UPDATE sync_meta SET suppress_triggers=1 WHERE id=1").run();
    try {
      const names = cols.map((c: any) => String(c.name)).filter((n: string) => !pk.some((c: any) => c.name === n));
      if (names.length)
        d.prepare(`UPDATE "company_settings" SET ${names.map((n: string) => `"${n}"=?`).join(",")} WHERE ${where}`).run(
          ...names.map((n: string) => (merged[n] === undefined ? null : merged[n])),
          ...pk.map((c: any) => key[c.name]),
        );
      d.prepare("INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)").run(e.event_id);
      d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
        e.event_id,
        table,
        e.pk_json,
        e.operation,
        e.base_json,
        e.row_json,
        e.origin_device || "remote",
      );
      const ownDevice = String((d.prepare("SELECT device_id FROM sync_meta WHERE id=1").get() as any)?.device_id || "offline-device");
      d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,0)").run(
        crypto.randomUUID(),
        table,
        e.pk_json,
        "UPDATE",
        JSON.stringify(row),
        JSON.stringify(merged),
        ownDevice,
      );
    } finally {
      d.prepare("UPDATE sync_meta SET suppress_triggers=0 WHERE id=1").run();
    }
    return "merged-settings";
  }
  if (base === null) {
    if (current)
      throw Object.assign(new Error(`Conflict on ${table}: record already exists.`), {
        conflictDetail: { table, primary_key: key, reason: "A record with this key already exists on this device.", base: null, current, incoming: row },
      });
  } else if (!current || canon(current) !== canon(base))
    throw Object.assign(new Error(`Conflict on ${table}: record changed locally.`), {
      conflictDetail: { table, primary_key: key, reason: "This device record differs from the version last seen by the other device.", base, current: current || null, incoming: row },
    });
  d.prepare("UPDATE sync_meta SET suppress_triggers=1 WHERE id=1").run();
  try {
    if (e.operation === "DELETE") {
      if (current) d.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...pk.map((c: any) => key[c.name]));
    } else {
      if (!row || typeof row !== "object") throw new Error("Missing row data.");
      const names = cols.map((c: any) => c.name).filter((n: string) => Object.prototype.hasOwnProperty.call(row, n));
      const conflict = pk.map((c: any) => `"${c.name}"`).join(",");
      const updates = names
        .filter((n: string) => !pk.some((c: any) => c.name === n))
        .map((n: string) => `"${n}"=excluded."${n}"`)
        .join(",");
      d.prepare(
        `INSERT INTO "${table}" (${names.map((n: string) => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")}) ON CONFLICT (${conflict}) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}`,
      ).run(...names.map((n: string) => (row[n] === undefined ? null : row[n])));
    }
    d.prepare("INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)").run(e.event_id);
    d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
      e.event_id,
      table,
      e.pk_json,
      e.operation,
      e.base_json,
      e.row_json,
      e.origin_device || "remote",
    );
  } finally {
    d.prepare("UPDATE sync_meta SET suppress_triggers=0 WHERE id=1").run();
  }
  return "applied";
}
function reserveOfflineIdRanges(d: any, deviceId: string) {
  // Give each independently-created offline database a disjoint AUTOINCREMENT
  // range. Existing IDs remain unchanged; new local IDs avoid the common 1,2,3
  // collisions that otherwise occur when two databases create records offline.
  let hash = 2166136261;
  for (const ch of deviceId) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const prefix = (100000 + (hash % 800000)) * 1000000000;
  const tables = d.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql LIKE '%AUTOINCREMENT%' AND name NOT LIKE 'sqlite_%'").all() as any[];
  for (const t of tables) {
    if (excluded.has(t.name) || t.name.startsWith("license_") || t.name.startsWith("admin_")) continue;
    const exists = d.prepare("SELECT name FROM sqlite_sequence WHERE name=?").get(t.name);
    if (!exists) d.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(t.name, prefix);
    else d.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?").run(prefix, t.name);
  }
}
function safeRemote(raw: string) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash) throw new Error("Remote URL must not contain credentials, query strings or fragments.");
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("Remote sync URL must use HTTPS.");
  return u.toString().replace(/\/+$/, "");
}
async function handler(req: Request) {
  try {
<<<<<<< HEAD
    const body = await req.json().catch(() => ({}));
    const remoteUrl = safeRemote(String(body.remote_url || ""));
    const token = String(body.device_token || "");
    const remoteCompanyId = Number(body.remote_company_id || 0);
    const localCompanyId = Number(req.headers.get("x-aksh-company-id") || 0);
    const mode = req.headers.get("x-aksh-mode");
    if (!token || token.length > 300 || !remoteCompanyId || !localCompanyId || !["LIVE", "TEST"].includes(String(mode)))
      return NextResponse.json({ error: "Remote URL, pairing token, destination company and environment are required." }, { status: 400 });
    if (body.remote_mode && body.remote_mode !== mode) return NextResponse.json({ error: "LIVE and TEST cannot sync across environments. Pair each environment separately." }, { status: 400 });
    const d = db(mode as Mode, localCompanyId);
    const meta = d.prepare("SELECT device_id,remote_cursor FROM sync_meta WHERE id=1").get() as any;
    const deviceId = String(meta.device_id);
    reserveOfflineIdRanges(d, deviceId);
    const headers = { "content-type": "application/json", "x-solivy-device-token": token, "x-solivy-device-id": deviceId, "x-aksh-company-id": String(remoteCompanyId), "x-aksh-mode": String(mode) };
    const pending = d.prepare("SELECT seq,event_id,table_name,pk_json,operation,base_json,row_json,origin_device,created_at FROM sync_changes WHERE pushed=0 ORDER BY seq LIMIT 500").all() as any[];
    let pushed = 0;
    if (pending.length) {
      const resp = await fetch(remoteUrl + "/api/sync/exchange", { method: "POST", headers, body: JSON.stringify({ events: pending }), cache: "no-store" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok)
        return NextResponse.json(
          { error: data.error || `Remote push failed (${resp.status}).`, conflict: resp.status === 409, conflict_detail: data.conflict_detail || null, pending: pending.length },
          { status: resp.status === 409 ? 409 : 502 },
        );
      const ids = pending.map((e) => e.event_id);
      const mark = d.prepare("UPDATE sync_changes SET pushed=1 WHERE event_id=?");
      const tx = d.transaction(() => {
        for (const id of ids) mark.run(id);
      });
      tx();
      pushed = pending.length;
=======
    const body=await req.json().catch(()=>({}));
    const remoteUrl=safeRemote(String(body.remote_url||''));
    const token=String(body.device_token||'');
    const remoteCompanyId=Number(body.remote_company_id||0);
    const localCompanyId=Number(req.headers.get('x-aksh-company-id')||0);
    const mode=req.headers.get('x-aksh-mode');
    if(!token||token.length>300||!remoteCompanyId||!localCompanyId||!['LIVE','TEST'].includes(String(mode))) return NextResponse.json({error:'Remote URL, pairing token, destination company and environment are required.'},{status:400});
    if(body.remote_mode && body.remote_mode!==mode) return NextResponse.json({error:'LIVE and TEST cannot sync across environments. Pair each environment separately.'},{status:400});
    const d=db(mode as Mode,localCompanyId);
    const meta=d.prepare('SELECT device_id,remote_cursor FROM sync_meta WHERE id=1').get() as any;
    const deviceId=String(meta.device_id);
    reserveOfflineIdRanges(d,deviceId);
    const headers={'content-type':'application/json','x-solivy-device-token':token,'x-solivy-device-id':deviceId,'x-aksh-company-id':String(remoteCompanyId),'x-aksh-mode':String(mode)};
    const pending=d.prepare('SELECT seq,event_id,table_name,pk_json,operation,base_json,row_json,origin_device,created_at FROM sync_changes WHERE pushed=0 ORDER BY seq LIMIT 500').all() as any[];
    let pushed=0;
    if(pending.length) {
      const resp=await fetch(remoteUrl+'/api/sync/exchange',{method:'POST',headers,body:JSON.stringify({events:pending}),cache:'no-store'});
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) return NextResponse.json({error:data.error||`Remote push failed (${resp.status}).`,conflict:resp.status===409,conflict_detail:data.conflict_detail||null,pending:pending.length},{status:resp.status===409?409:502});
      const ids=pending.map(e=>e.event_id);
      const mark=d.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?');
      const tx=d.transaction(()=>{for(const id of ids)mark.run(id)});tx();
      pushed=pending.length;
    }
    const pullUrl=remoteUrl+'/api/sync/exchange?cursor='+encodeURIComponent(String(meta.remote_cursor||0))+'&limit=500';
    const pull=await fetch(pullUrl,{method:'GET',headers,cache:'no-store'});
    const pulled=await pull.json().catch(()=>({}));
    if(!pull.ok) return NextResponse.json({error:pulled.error||`Remote pull failed (${pull.status}).`,pushed},{status:502});
    const events=Array.isArray(pulled.events)?pulled.events:[];
    const summary={applied:0,duplicates:0,unchanged:0};
    try {
      const tx=d.transaction(()=>{
        for(const e of events) {
          const status=applyLocal(d,e);
          if(status==='duplicate')summary.duplicates++;else if(status==='same')summary.unchanged++;else summary.applied++;
        }
        d.prepare('UPDATE sync_meta SET remote_cursor=?,last_sync_at=CURRENT_TIMESTAMP,paired_url=?,paired_company_id=?,sync_mode=? WHERE id=1')
          .run(Number(pulled.cursor||meta.remote_cursor||0),remoteUrl,remoteCompanyId,mode);
      });
      tx();
    } catch(e:any) {
      return NextResponse.json({error:e?.message||'Local apply failed; downloaded batch was not committed.',conflict:true,conflict_detail:e?.conflictDetail||null,pushed,pending_downloads:events.length},{status:409});
>>>>>>> 3cf4b25 (new update)
    }
    const pullUrl = remoteUrl + "/api/sync/exchange?cursor=" + encodeURIComponent(String(meta.remote_cursor || 0)) + "&limit=500";
    const pull = await fetch(pullUrl, { method: "GET", headers, cache: "no-store" });
    const pulled = await pull.json().catch(() => ({}));
    if (!pull.ok) return NextResponse.json({ error: pulled.error || `Remote pull failed (${pull.status}).`, pushed }, { status: 502 });
    const events = Array.isArray(pulled.events) ? pulled.events : [];
    const summary = { applied: 0, duplicates: 0, unchanged: 0 };
    try {
      const tx = d.transaction(() => {
        for (const e of events) {
          const status = applyLocal(d, e);
          if (status === "duplicate") summary.duplicates++;
          else if (status === "same") summary.unchanged++;
          else summary.applied++;
        }
        d.prepare("UPDATE sync_meta SET remote_cursor=?,last_sync_at=CURRENT_TIMESTAMP,paired_url=?,paired_company_id=?,sync_mode=? WHERE id=1").run(
          Number(pulled.cursor || meta.remote_cursor || 0),
          remoteUrl,
          remoteCompanyId,
          mode,
        );
      });
      tx();
    } catch (e: any) {
      return NextResponse.json(
        { error: e?.message || "Local apply failed; downloaded batch was not committed.", conflict: true, conflict_detail: e?.conflictDetail || null, pushed, pending_downloads: events.length },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      mode,
      local_company_id: localCompanyId,
      remote_company_id: remoteCompanyId,
      pushed,
      pulled: events.length,
      ...summary,
      last_sync_at: new Date().toISOString(),
      has_more: Boolean(pulled.has_more),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Sync failed." }, { status: 400 });
  }
}
const __wrapped_POST = withPostgresSQLiteBridge(handler);
export async function POST(req: Request) {
  return __wrapped_POST(req);
}
