import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { sessionMode } from '../../../lib/db';
import {NextResponse} from 'next/server';import {db,Mode} from '../../../lib/db';async function __bridge_POST(req:Request){try{const x=await req.json();const d=db(sessionMode(req), Number(req.headers.get('x-aksh-company-id')||x.company_id||1));d.prepare('INSERT INTO bank_matches(payment_id,statement_date,statement_amount,reference) VALUES(?,?,?,?)').run(x.payment_id,x.statement_date,Number(x.statement_amount),x.reference||'');return NextResponse.json({ok:true})}catch(e:any){return NextResponse.json({error:e.message},{status:400})}}

export const runtime = 'nodejs';

const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }
