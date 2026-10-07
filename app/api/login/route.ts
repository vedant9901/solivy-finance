import {NextResponse} from 'next/server';
import {adminDb} from '../../../lib/db';
import {signSession,COOKIE,hashPassword,verifyPassword} from '../../../lib/session';

const attempts=new Map<string,{count:number,until:number}>();
function clientKey(req:Request){return String(req.headers.get('x-forwarded-for')||req.headers.get('x-real-ip')||'unknown').split(',')[0].trim()||'unknown'}
function rateLimited(key:string){const now=Date.now();const x=attempts.get(key);if(!x||x.until<=now){attempts.delete(key);return false}return x.count>=8}
function failed(key:string){const now=Date.now();const x=attempts.get(key);if(!x||x.until<=now){attempts.set(key,{count:1,until:now+15*60*1000});return}x.count++;x.until=now+15*60*1000;attempts.set(key,x)}
function success(key:string){attempts.delete(key)}
export async function POST(req:Request){
 const key=clientKey(req);
 try{
  if(rateLimited(key))return NextResponse.json({error:'Too many login attempts. Please wait 15 minutes and try again.'},{status:429,headers:{'Retry-After':'900','Cache-Control':'no-store'}});
  const x=await req.json();const companyId=Number(x.company_id||0);const mode=x.mode==='TEST'?'TEST':'LIVE';
  if(!companyId)throw Error('Select a company');
  const username=String(x.username||'').trim();const supplied=String(x.password||'');
  if(!username||!supplied)throw Error('Username and password are required');
  const d=await adminDb();
  const u=await d.prepare('SELECT id,username,name,role,active,password,password_hash FROM admin_users WHERE username=?').get(username) as any;
  if(!u||!u.active)throw Error('Invalid username or password');
  const allowed=await d.prepare('SELECT can_live,can_test FROM user_companies WHERE user_id=? AND company_id=?').get(u.id,companyId) as any;
  if(!allowed||((mode==='LIVE'&&!allowed.can_live)||(mode==='TEST'&&!allowed.can_test)))throw Error('This user is not assigned to the selected company/environment');
  let ok=verifyPassword(supplied,u.password_hash);
  if(!ok&&u.password&&supplied===String(u.password)){
    ok=true;await d.prepare('UPDATE admin_users SET password_hash=?,password=? WHERE id=?').run(hashPassword(supplied),'',u.id);
  }
  if(!ok)throw Error('Invalid username or password');
  const company=await d.prepare('SELECT id,name,code FROM companies WHERE id=? AND active=1').get(companyId) as any;
  if(!company)throw Error('Company is inactive or unavailable');
  success(key);
  const res=NextResponse.json({ok:true,name:u.name,role:u.role,mode,company},{headers:{'Cache-Control':'no-store'}});
  res.cookies.set(COOKIE,signSession(u.username,u.role,companyId,mode),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:60*60*12});
  return res;
 }catch(e:any){failed(key);return NextResponse.json({error:e?.message||'Invalid username or password'},{status:401,headers:{'Cache-Control':'no-store'}})}
}
