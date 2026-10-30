import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import {db,Mode,adminDb} from '../../../lib/db';
export const dynamic='force-dynamic';
async function __bridge_GET(req:Request){try{const u=new URL(req.url);const mode = sessionMode(req);const requested=Number(u.searchParams.get('company_id')||0);const isAdmin=req.headers.get('x-aksh-role')==='ADMIN';const sessionCompany=Number(req.headers.get('x-aksh-company-id')||1);const companyId=isAdmin&&requested?requested:sessionCompany;const d=adminDb();const company=d.prepare('SELECT id,name,code,active FROM companies WHERE id=?').get(companyId) as any;if(!company)throw Error('Company not found');if(!isAdmin&&companyId!==sessionCompany)throw Error('Company access denied');const buf=db(mode,companyId).serialize();const body=new Uint8Array(buf.length);body.set(buf);const safe=String(company.code).replace(/[^A-Za-z0-9_-]/g,'_');return new Response(body as BodyInit,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${safe}-${mode.toLowerCase()}-backup.db"`}})}catch(e:any){return Response.json({error:e.message},{status:403})}}

export const runtime = 'nodejs';

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET,{scope:'company',extraFiles:(req)=>{const id=Number(new URL(req.url).searchParams.get('company_id')||0);const mode=req.headers.get('x-aksh-mode')==='TEST'?'TEST' as const:'LIVE' as const;return id>0?[{id,mode}]:[]}});
export async function GET(req: Request) { return __wrapped_GET(req); }
