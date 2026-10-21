import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminDb, db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const excluded = new Set(['sync_meta','sync_changes','sync_applied_events','users','sqlite_sequence']);
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
function currentRow(d:any,table:string,pkCols:any[],pkObj:any) {
  const where=pkCols.map(c=>`"${c.name}"=?`).join(' AND ');
  const vals=pkCols.map(c=>pkObj[c.name]);
  return d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...vals) as any;
}
function applyEvent(d:any,e:any,localDeviceId:string) {
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
  if (base===null) {
    if (current) throw new Error(`Conflict on ${e.table_name}: record already exists.`);
  } else if (!current || canon(current)!==canon(base)) {
    throw new Error(`Conflict on ${e.table_name}: record changed on this side. Review before retrying.`);
  }
  d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
  try {
    if (e.operation==='DELETE') {
      if (current) d.prepare(`DELETE FROM "${e.table_name}" WHERE ${pk.map(c=>`"${c.name}"=?`).join(' AND ')}`).run(...pk.map(c=>pkObj[c.name]));
    } else {
      if (!desired || typeof desired!=='object') throw new Error('Missing row payload.');
      const names=cols.map(c=>c.name).filter(n=>Object.prototype.hasOwnProperty.call(desired,n));
      if (!names.length || !pk.every(c=>names.includes(c.name))) throw new Error('Row payload is incomplete.');
      const quoted=names.map(n=>`"${n}"`).join(',');
      const marks=names.map(()=>'?').join(',');
      const updates=names.filter(n=>!pk.some(c=>c.name===n)).map(n=>`"${n}"=excluded."${n}"`).join(',');
      const conflict=pk.map(c=>`"${c.name}"`).join(',');
      const sql=`INSERT INTO "${e.table_name}" (${quoted}) VALUES (${marks}) ON CONFLICT (${conflict}) ${updates ? `DO UPDATE SET ${updates}` : 'DO NOTHING'}`;
      d.prepare(sql).run(...names.map(n=>desired[n]===undefined?null:desired[n]));
    }
    d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(e.event_id);
    d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)')
      .run(e.event_id,e.table_name,e.pk_json,e.operation,e.base_json,e.row_json,e.origin_device||'remote');
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
  try {
    if (req.method==='GET') {
      const u=new URL(req.url);
      const cursor=Math.max(0,Number(u.searchParams.get('cursor')||0));
      const limit=Math.min(500,Math.max(1,Number(u.searchParams.get('limit')||200)));
      const events=d.prepare(`SELECT seq,event_id,table_name,pk_json,operation,base_json,row_json,origin_device,created_at FROM sync_changes WHERE seq>? AND origin_device<>? ORDER BY seq LIMIT ?`).all(cursor,ctx.deviceId,limit) as any[];
      const max=d.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM sync_changes').get() as any;
      const hasMore=events.length===limit;
      const nextCursor=hasMore?Number(events[events.length-1]?.seq||cursor):Number(max?.n||cursor);
      return NextResponse.json({ok:true,events,cursor:nextCursor,has_more:hasMore});
    }
    if (req.method==='POST') {
      const body=await req.json().catch(()=>({}));
      const events=Array.isArray(body.events)?body.events:[];
      if (!events.length) return NextResponse.json({ok:true,applied:0,duplicates:0});
      if (events.length>500) return NextResponse.json({error:'Maximum 500 events per batch.'},{status:413});
      const result:any={applied:0,duplicates:0,alreadyCurrent:0};
      const tx=d.transaction(()=>{
        for (const e of events) {
          const status=applyEvent(d,e,ctx.deviceId);
          if(status==='duplicate') result.duplicates++;
          else if(status==='already-current') result.alreadyCurrent++;
          else result.applied++;
        }
      });
      try { tx(); } catch(e:any) { return NextResponse.json({error:e?.message||'Sync batch rejected; no changes in this batch were committed.',conflict:true},{status:409}); }
      return NextResponse.json({ok:true,...result});
    }
    return NextResponse.json({error:'Method not allowed.'},{status:405});
  } catch(e:any) { return NextResponse.json({error:e?.message||'Sync exchange failed.'},{status:400}); }
}
const __wrapped_GET=withPostgresSQLiteBridge(handler);
const __wrapped_POST=withPostgresSQLiteBridge(handler);
export async function GET(req:Request){return __wrapped_GET(req);}
export async function POST(req:Request){return __wrapped_POST(req);}
