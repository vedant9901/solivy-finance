import {NextResponse} from 'next/server';
import {db,Mode} from '../../../lib/db';

function modeOf(x:any):Mode{return (x.mode||'LIVE') as Mode}
function companyOf(req:Request,x:any){return Number(req.headers.get('x-aksh-company-id')||x.company_id||1)}

export async function POST(req:Request){try{const x=await req.json();const d=await db(modeOf(x),companyOf(req,x));const name=String(x.name||'').trim();if(!name)throw Error('Third party name is required');if(x.id){await d.prepare(`UPDATE third_parties SET name=?,address=?,contact=?,gst=?,pan=?,email=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(name,x.address||'',x.contact||'',x.gst||'',x.pan||'',x.email||'',x.active===0?0:1,Number(x.id));return NextResponse.json({ok:true,id:Number(x.id)})}const r=await d.prepare(`INSERT INTO third_parties(name,address,contact,gst,pan,email,active) VALUES(?,?,?,?,?,?,1)`).run(name,x.address||'',x.contact||'',x.gst||'',x.pan||'',x.email||'');return NextResponse.json({ok:true,id:Number(r.lastInsertRowid)})}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}
export async function PUT(req:Request){return POST(req)}
export async function DELETE(req:Request){try{const x=await req.json();const d=await db(modeOf(x),companyOf(req,x));await d.prepare('UPDATE third_parties SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(x.id));return NextResponse.json({ok:true})}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}
