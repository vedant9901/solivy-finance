import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/db';
import { signSession, COOKIE, hashPassword, verifyPassword, cookieOptions } from '../../../lib/session';
import { checkLoginRateLimit, clearLoginFailures, loginRateLimitKey, recordLoginFailure } from '../../../lib/security';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const key = loginRateLimitKey(req, username);
  const limit = checkLoginRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json({ error: `Too many login attempts. Try again in ${limit.retryAfter} seconds.` }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
  }
  try {
    const companyId = Number(body.company_id || 0);
    const mode = body.mode === 'TEST' ? 'TEST' : 'LIVE';
    if (!companyId) throw Error('Select a company');
    if (!username || username.length > 80) throw Error('Invalid username or password');
    const supplied = String(body.password || '');
    if (!supplied || supplied.length > 256) throw Error('Invalid username or password');
    if ((username.toLowerCase() === 'admin' && supplied === 'admin123') || (username.toLowerCase() === 'tester' && supplied === 'test123')) {
      throw Error('The legacy default password is disabled. Use account recovery or ask your SOLIVY administrator to reset this account.');
    }

    const d = adminDb();
    const u = d.prepare('SELECT id,username,name,role,active,password,password_hash,menu_access FROM admin_users WHERE username=?').get(username) as any;
    if (!u || !u.active) throw Error('Invalid username or password');
    if (u.role === 'TESTER' && mode !== 'TEST') throw Error('Invalid username or password');
    const allowed = d.prepare('SELECT can_live,can_test FROM user_companies WHERE user_id=? AND company_id=?').get(u.id, companyId) as any;
    if (!allowed || ((mode === 'LIVE' && !allowed.can_live) || (mode === 'TEST' && !allowed.can_test))) throw Error('Invalid username or password');

    let ok = verifyPassword(supplied, u.password_hash);
    if (!ok && u.password && supplied === String(u.password)) {
      ok = true;
      d.prepare('UPDATE admin_users SET password_hash=?,password=? WHERE id=?').run(hashPassword(supplied), '', u.id);
    }
    if (!ok) throw Error('Invalid username or password');

    const company = d.prepare('SELECT id,name,code,active FROM companies WHERE id=? AND active=1').get(companyId) as any;
    if (!company) throw Error('Invalid username or password');
    clearLoginFailures(key);
    const defaultMenuIds=['dashboard','accounts','account-movements','parties','purchase','payments','money-in','interest','funding','import','ledger','receivables','reports','bank','backup','gst','commercial-bills','document-settings','settings'];let menuAccess:string[]=u.role==='ADMIN'?defaultMenuIds:['dashboard'];try{const parsed=JSON.parse(String(u.menu_access||''));if(Array.isArray(parsed))menuAccess=parsed.filter((m:any)=>defaultMenuIds.includes(String(m)))}catch{}const res = NextResponse.json({ ok: true, name: u.name, role: u.role, mode, company, menu_access: menuAccess });
    res.cookies.set(COOKIE, signSession(u.username, u.role, companyId, mode, menuAccess), cookieOptions(req));
    return res;
  } catch (e: any) {
    recordLoginFailure(key);
    return NextResponse.json({ error: String(e?.message || 'Invalid username or password') }, { status: 401 });
  }
}
