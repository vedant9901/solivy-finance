import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import fs from 'node:fs';
import path from 'node:path';
import { sessionMode } from '../../../lib/db';
import {NextResponse} from 'next/server';import {resetMode,clearTransactionData,Mode,db,databasePath} from '../../../lib/db';
function makeBackup(mode:Mode,companyId:number){const originalPath=databasePath(mode,companyId);const backupDir=path.join(path.dirname(originalPath),'pre-destructive-backups');fs.mkdirSync(backupDir,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const backupPath=path.join(backupDir,`${companyId}-${mode}-${stamp}.db`);fs.writeFileSync(backupPath,db(mode,companyId).serialize(),{flag:'wx'});return path.basename(backupPath)}
async function __bridge_POST(req:Request){try{const role=String(req.headers.get('x-aksh-role')||'');if(role!=='ADMIN')return NextResponse.json({error:'Administrator access required'},{status:403});const x=await req.json();const mode = sessionMode(req);const companyId=Number(req.headers.get('x-aksh-company-id')||x.company_id||1);const phrase=String(x.confirmation||'');if(!['LIVE','TEST'].includes(mode))return NextResponse.json({error:'Not allowed'},{status:403});
if(!['purge','clear_transactions'].includes(x.action))return NextResponse.json({error:'Not allowed'},{status:403});if(x.action==='clear_transactions'){if(phrase!==`CLEAR TRANSACTIONS ${mode}`)throw Error(`Type CLEAR TRANSACTIONS ${mode} to confirm`);const backupFile=makeBackup(mode,companyId);clearTransactionData(mode,companyId);return NextResponse.json({ok:true,mode,companyId,message:`${mode} transaction data cleared. Master data was preserved. A pre-change backup was saved.`,backupFile});}
if(phrase!==`PURGE ${mode}`)throw Error(`Type PURGE ${mode} to confirm`);const backupFile=makeBackup(mode,companyId);resetMode(mode,companyId);return NextResponse.json({ok:true,mode,companyId,message:`${mode} database purged successfully. A pre-change backup was saved.`,backupFile});}catch(e:any){return NextResponse.json({error:e.message},{status:400});}}

export const runtime = 'nodejs';

const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }
