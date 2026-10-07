import {NextRequest,NextResponse} from 'next/server';

const COOKIE='aksh_session';
const ADMIN_ALL=new Set(['/api/admin','/api/admin-backup-all','/api/document-settings','/api/users','/api/test-to-live','/api/parties-delete','/api/reverse']);
const ADMIN_MUTATIONS=new Set(['/api/companies','/api/settings']);
const READ_ONLY_PUBLIC=new Set(['/api/login','/api/login-companies','/api/logout']);

async function valid(token:string|undefined){
  try{
    const secret=String(process.env.SESSION_SECRET||'').trim();
    if(!secret||!token)return null;
    const [payload,sig]=token.split('.');
    if(!payload||!sig)return null;
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const ok=await crypto.subtle.verify('HMAC',key,base64(sig),new TextEncoder().encode(payload));
    if(!ok)return null;
    const x=JSON.parse(new TextDecoder().decode(base64(payload)));
    return !!x?.u&&Number(x.e)>Date.now()&&Number(x.c)>0?x:null;
  }catch{return null}
}
function base64(s:string){const bin=atob(s.replace(/-/g,'+').replace(/_/g,'/'));const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
function secureHeaders(res:NextResponse,isApi=false){
  res.headers.set('X-Content-Type-Options','nosniff');
  res.headers.set('X-Frame-Options','DENY');
  res.headers.set('Referrer-Policy','strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy','camera=(),microphone=(),geolocation=()');
  res.headers.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  if(isApi)res.headers.set('Cache-Control','no-store, max-age=0');
  return res;
}
export async function proxy(req:NextRequest){
  const path=req.nextUrl.pathname;
  if(path==='/login'||READ_ONLY_PUBLIC.has(path)||path.startsWith('/_next/')||path==='/favicon.ico'){
    return secureHeaders(NextResponse.next(),false);
  }
  const session=await valid(req.cookies.get(COOKIE)?.value);
  if(!session){
    if(path.startsWith('/api/'))return secureHeaders(NextResponse.json({error:'Authentication required'},{status:401}),true);
    return NextResponse.redirect(new URL('/login',req.url));
  }
  const role=String(session.r||'');
  const isApi=path.startsWith('/api/');
  const method=req.method.toUpperCase();
  if(isApi&&ADMIN_ALL.has(path)&&role!=='ADMIN')return secureHeaders(NextResponse.json({error:'Administrator access required'},{status:403}),true);
  if(isApi&&ADMIN_MUTATIONS.has(path)&&role!=='ADMIN')return secureHeaders(NextResponse.json({error:'Administrator access required'},{status:403}),true);
  if(isApi&&method!=='GET'&&method!=='HEAD'&&method!=='OPTIONS'&&role==='VIEWER')return secureHeaders(NextResponse.json({error:'Read-only access. You do not have permission to change financial data.'},{status:403}),true);
  const len=Number(req.headers.get('content-length')||0);
  const max=path==='/api/import-finance'?15*1024*1024:2*1024*1024;
  if(isApi&&len>max)return secureHeaders(NextResponse.json({error:`Request is too large. Maximum allowed is ${Math.round(max/1024/1024)} MB.`},{status:413}),true);
  const h=new Headers(req.headers);
  h.set('x-aksh-company-id',String(session.c));
  h.set('x-aksh-role',role);
  h.set('x-aksh-user',String(session.u||''));
  h.set('x-aksh-mode',String(session.m||'LIVE'));
  if(isApi){
    const requested=req.headers.get('x-aksh-mode')||req.nextUrl.searchParams.get('mode');
    if(requested&&requested!==String(session.m||'LIVE')&&!(role==='ADMIN'&&path==='/api/backup'))return secureHeaders(NextResponse.json({error:`Session is in ${session.m||'LIVE'} mode. Switch environment before accessing ${requested}.`},{status:403}),true);
  }
  const res=NextResponse.next({request:{headers:h}});
  return secureHeaders(res,isApi);
}
export const config={matcher:['/((?!_next/static|_next/image).*)']};
