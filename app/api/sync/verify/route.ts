import { NextResponse } from 'next/server';
import { db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function safeRemote(raw:string){
 const u=new URL(raw);
 if(u.username||u.password||u.search||u.hash) throw new Error('Remote URL must not contain credentials, query strings or fragments.');
 const local=['localhost','127.0.0.1','::1'].includes(u.hostname);
 if(u.protocol!=='https:'&&!(local&&u.protocol==='http:')) throw new Error('Remote sync URL must use HTTPS.');
 if(u.pathname!=='/'&&u.pathname!=='') throw new Error('Enter the website base URL, not an API path.');
 return u.origin;
}
async function handler(req:Request){
 try{
  const body=await req.json().catch(()=>({}));
  const remoteUrl=safeRemote(String(body.remote_url||''));
  const token=String(body.device_token||'');
  const remoteCompanyId=Number(body.remote_company_id||0);
  const localCompanyId=Number(req.headers.get('x-aksh-company-id')||0);
  const mode=String(req.headers.get('x-aksh-mode')||'');
  if(!token||token.length>300||!Number.isSafeInteger(remoteCompanyId)||remoteCompanyId<1||!localCompanyId||!['LIVE','TEST'].includes(mode)) return NextResponse.json({ok:false,error:'Online URL, token, destination company, and current environment are required.'},{status:400});
  if(body.remote_mode&&body.remote_mode!==mode) return NextResponse.json({ok:false,error:'LIVE and TEST environments cannot be paired together.'},{status:400});
  const localDb=db(mode as Mode,localCompanyId);
  const meta=localDb.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any;
  if(!meta?.device_id) return NextResponse.json({ok:false,error:'Local sync metadata is not initialized. Open the application again and retry.'},{status:409});
  const response=await fetch(`${remoteUrl}/api/sync/exchange?cursor=0&limit=1`,{method:'GET',headers:{'x-solivy-device-token':token,'x-solivy-device-id':String(meta.device_id),'x-aksh-company-id':String(remoteCompanyId),'x-aksh-mode':mode},cache:'no-store',signal:AbortSignal.timeout(12000)});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok) return NextResponse.json({ok:false,error:payload.error||`Online verification failed (HTTP ${response.status}).`,http_status:response.status},{status:response.status===401||response.status===403?response.status:502});
  return NextResponse.json({ok:true,local_company_id:localCompanyId,remote_company_id:remoteCompanyId,mode,authorized:true,online_reachable:true,message:'Token is valid for the selected online company and environment. This test does not change or synchronize financial records.'});
 }catch(e:any){return NextResponse.json({ok:false,error:e?.name==='TimeoutError'?'Online verification timed out after 12 seconds.':e?.message||'Unable to verify the online connection.'},{status:400});}
}
const __wrapped_POST=withPostgresSQLiteBridge(handler,{noRetry:true});
export async function POST(req:Request){return __wrapped_POST(req);}
