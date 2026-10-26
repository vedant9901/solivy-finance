import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode, db, adminDb } from '../../../lib/db';
import { NextResponse } from 'next/server';

async function __bridge_GET(req: Request) {
  try {
    const u = new URL(req.url); const mode = sessionMode(req);
    const companyId = Number(req.headers.get('x-aksh-company-id') || u.searchParams.get('company_id') || 1);
    const d = db(mode, companyId); const admin=adminDb(); const username=String(req.headers.get('x-aksh-user')||''); const user=admin.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(username) as any; const grants=user?admin.prepare(`SELECT company_id FROM user_companies WHERE user_id=? AND ${mode==='TEST'?'can_test=1':'can_live=1'}`).all(user.id) as any[]:[]; const allowed=grants.map((g:any)=>Number(g.company_id)).filter((id:number)=>id!==companyId); const suffix=allowed.length?` OR p.source_company_id IN (${allowed.map(()=>'?').join(',')})`:''; const tSuffix=allowed.length?` OR tp.source_company_id IN (${allowed.map(()=>'?').join(',')})`:'';
    const rows = d.prepare(`SELECT p.id AS party_id,p.name AS party_name,COALESCE(p.party_type,'') AS party_type,a.id AS alias_id,a.alias FROM parties p LEFT JOIN party_aliases a ON a.party_id=p.id WHERE (COALESCE(p.source_company_id,0)=0${suffix}) ORDER BY lower(p.name),lower(a.alias)`).all(...allowed);
    const parties = d.prepare(`SELECT p.id AS party_id,p.name AS party_name,COALESCE(p.party_type,'') AS party_type FROM parties p WHERE (COALESCE(p.source_company_id,0)=0${suffix}) ORDER BY lower(p.name)`).all(...allowed);
    const thirdParties = d.prepare(`SELECT tp.id,tp.name,COALESCE(tp.contact,'') AS contact,COALESCE(tp.email,'') AS email,COALESCE(tp.gst,'') AS gst,tp.active FROM third_parties tp WHERE (COALESCE(tp.source_company_id,0)=0${tSuffix}) ORDER BY lower(tp.name)`).all(...allowed);
    return NextResponse.json({ok:true,rows,parties,thirdParties});
  } catch(e:any) { return NextResponse.json({error:e.message},{status:400}); }
}
async function __bridge_POST(req: Request) {
  try {
    const x = await req.json(); const mode = sessionMode(req);
    const d = db(mode, Number(req.headers.get('x-aksh-company-id') || x.company_id || 1));
    const partyId = Number(x.party_id); const alias = String(x.alias||'').trim().replace(/\s+/g,' ');
    if(!Number.isInteger(partyId)||partyId<=0) throw Error('Choose an existing party.');
    if(alias.length<2) throw Error('Alias must contain at least 2 characters.');
    const party=d.prepare('SELECT id,name FROM parties WHERE id=? AND active=1').get(partyId) as any;
    if(!party) throw Error('Party was not found or is inactive.');
    if(party.name.trim().toLocaleLowerCase()===alias.toLocaleLowerCase()) throw Error('Alias is the same as the party name.');
    const conflict=d.prepare('SELECT p.name FROM party_aliases a JOIN parties p ON p.id=a.party_id WHERE lower(trim(a.alias))=lower(trim(?)) AND a.party_id<>?').get(alias,partyId) as any;
    const nameConflict=d.prepare('SELECT name FROM parties WHERE lower(trim(name))=lower(trim(?)) AND id<>?').get(alias,partyId) as any;
    if(conflict||nameConflict) throw Error(`This alias is already assigned to ${conflict?.name||nameConflict?.name}.`);
    const exists=d.prepare('SELECT id FROM party_aliases WHERE party_id=? AND lower(trim(alias))=lower(trim(?))').get(partyId,alias) as any;
    if(exists) return NextResponse.json({ok:true,aliasId:exists.id,alreadyExists:true});
    const r=d.prepare('INSERT INTO party_aliases(party_id,alias) VALUES(?,?)').run(partyId,alias);
    return NextResponse.json({ok:true,aliasId:Number(r.lastInsertRowid)});
  } catch(e:any) { return NextResponse.json({error:e.message},{status:400}); }
}
async function __bridge_DELETE(req: Request) {
  try { const x=await req.json(); const d=db(sessionMode(req),Number(req.headers.get('x-aksh-company-id')||x.company_id||1)); const id=Number(x.alias_id); if(!Number.isInteger(id)||id<=0) throw Error('Choose a valid alias.'); const r=d.prepare('DELETE FROM party_aliases WHERE id=?').run(id); if(!r.changes) throw Error('Alias not found.'); return NextResponse.json({ok:true}); }
  catch(e:any) { return NextResponse.json({error:e.message},{status:400}); }
}

async function __bridge_PUT(req: Request) {
  try {
    const x = await req.json(); const mode = sessionMode(req);
    const d = db(mode, Number(req.headers.get('x-aksh-company-id') || x.company_id || 1));
    const id = Number(x.alias_id); const alias = String(x.alias || '').trim().replace(/\s+/g, ' ');
    if (!Number.isInteger(id) || id <= 0) throw Error('Choose a valid alias.');
    if (alias.length < 2) throw Error('Alias must contain at least 2 characters.');
    const current = d.prepare('SELECT id,party_id FROM party_aliases WHERE id=?').get(id) as any;
    if (!current) throw Error('Alias not found. Refresh the page and try again.');
    const party = d.prepare('SELECT id,name FROM parties WHERE id=? AND active=1').get(current.party_id) as any;
    if (!party) throw Error('The linked party is missing or inactive.');
    if (String(party.name).trim().toLocaleLowerCase() === alias.toLocaleLowerCase()) throw Error('Alias is the same as the party name.');
    const conflict = d.prepare('SELECT p.name FROM party_aliases a JOIN parties p ON p.id=a.party_id WHERE lower(trim(a.alias))=lower(trim(?)) AND a.id<>?').get(alias,id) as any;
    const nameConflict = d.prepare('SELECT name FROM parties WHERE lower(trim(name))=lower(trim(?)) AND id<>?').get(alias,current.party_id) as any;
    if (conflict || nameConflict) throw Error(`This alias is already assigned to ${conflict?.name || nameConflict?.name}.`);
    d.prepare('UPDATE party_aliases SET alias=? WHERE id=?').run(alias,id);
    return NextResponse.json({ok:true});
  } catch(e:any) { return NextResponse.json({error:e.message},{status:400}); }
}

export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }
const __wrapped_DELETE = withPostgresSQLiteBridge(__bridge_DELETE);
const __wrapped_PUT = withPostgresSQLiteBridge(__bridge_PUT);
export async function DELETE(req: Request) { return __wrapped_DELETE(req); }

export async function PUT(req: Request) { return __wrapped_PUT(req); }
