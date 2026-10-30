import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import {NextResponse} from 'next/server';
import {db,Mode} from '../../../lib/db';

function companyOf(req:Request,x:any){return Number(req.headers.get('x-aksh-company-id')||x.company_id||1)}

async function __bridge_POST(req:Request){try{const x=await req.json();const d=db(sessionMode(req),companyOf(req,x));const name=String(x.name||'').trim();if(!name)throw Error('Third party name is required');if(x.id){const current=d.prepare('SELECT source_company_id FROM third_parties WHERE id=?').get(Number(x.id)) as any;if(!current)throw Error('Third party not found.');d.prepare(`UPDATE third_parties SET name=?,address=?,contact=?,gst=?,pan=?,email=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(name,x.address||'',x.contact||'',x.gst||'',x.pan||'',x.email||'',x.active===0?0:1,Number(x.id));return NextResponse.json({ok:true,id:Number(x.id)})}const r=d.prepare(`INSERT INTO third_parties(name,address,contact,gst,pan,email,active) VALUES(?,?,?,?,?,?,1)`).run(name,x.address||'',x.contact||'',x.gst||'',x.pan||'',x.email||'');return NextResponse.json({ok:true,id:Number(r.lastInsertRowid)})}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}
async function __bridge_PUT(req:Request){return POST(req)}
async function __bridge_DELETE(req:Request){try{const x=await req.json();const d=db(sessionMode(req),companyOf(req,x));const current=d.prepare('SELECT source_company_id FROM third_parties WHERE id=?').get(Number(x.id)) as any;if(!current)throw Error('Third party not found.');d.prepare('UPDATE third_parties SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(x.id));return NextResponse.json({ok:true})}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}

export const runtime = 'nodejs';

const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }

const __wrapped_PUT = withPostgresSQLiteBridge(__bridge_PUT);
export async function PUT(req: Request) { return __wrapped_PUT(req); }

const __wrapped_DELETE = withPostgresSQLiteBridge(__bridge_DELETE);
export async function DELETE(req: Request) { return __wrapped_DELETE(req); }
