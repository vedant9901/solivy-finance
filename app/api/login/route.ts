import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/db';
import { signSession, COOKIE, hashPassword, verifyPassword, cookieOptions } from '../../../lib/session';
import { loginRateLimitKey } from '../../../lib/security';
import { checkThrottle, recordFailure, clearFailures } from '../../../lib/login-throttle';

async function __bridge_POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const key = loginRateLimitKey(req, username);
  const limit = await checkThrottle(key);
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

    // Use the bridged admin database as the single source of truth for online and
    // offline authentication. Company creation and user-company assignments are
    // written through this database; a separate native-PG auth path can become
    // stale and reject users for newly-created organizations.
    const d = adminDb();
    const u: any = d.prepare('SELECT id,username,name,role,active,password,password_hash,menu_access,card_access FROM admin_users WHERE lower(username)=lower(?)').get(username);
    if (!u || !u.active) throw Error('Invalid username or password');
    if (u.role === 'TESTER' && mode !== 'TEST') throw Error('Invalid username or password');

    const allowed: any = d.prepare('SELECT can_live,can_test FROM user_companies WHERE user_id=? AND company_id=?').get(u.id, companyId);
    if (!allowed || ((mode === 'LIVE' && !allowed.can_live) || (mode === 'TEST' && !allowed.can_test))) {
      throw Error('Invalid username or password');
    }

    // Plaintext legacy passwords are hashed by the admin.db v2.7 migration; only hashes are accepted.
    const ok = verifyPassword(supplied, u.password_hash);
    if (!ok) throw Error('Invalid username or password');

    const company: any = d.prepare('SELECT id,name,code,active FROM companies WHERE id=? AND active=1').get(companyId);
    if (!company) throw Error('Invalid username or password');
    await clearFailures(key);
    const defaultMenuIds=['dashboard','profile','sauda','godowns','accounts','account-movements','parties','party-aliases','purchase','payments','money-in','money-out','interest','funding','import','ledger','receivables','reports','bank','backup','secondary-backup','tally-export','bank-statement-import','gst','commercial-bills','document-settings','settings','transfers','sync'];let menuAccess:string[]=u.role==='ADMIN'?defaultMenuIds:(String(u.role)==='TRADER'?['dashboard','purchase','sauda','godowns']:String(u.role)==='SUPPLIER'?['dashboard','purchase']:['dashboard']);try{const parsed=JSON.parse(String(u.menu_access||''));if(Array.isArray(parsed))menuAccess=parsed.filter((m:any)=>defaultMenuIds.includes(String(m)))}catch{}let cardAccess:string[]=u.role==='ADMIN'?['kpi-parties','kpi-purchase-cost','kpi-paid','kpi-vendor-outstanding','kpi-finance-profit','kpi-average-earning','business-pulse','due-pay-today','due-pay-tomorrow','due-receive-today','due-receive-tomorrow','due-interest-today','due-interest-tomorrow','due-this-week','overdue-receivables','bank-cash','realised-profit','charts']:[];try{const ca=JSON.parse(String(u.card_access||''));if(Array.isArray(ca))cardAccess=ca.filter((v:any)=>typeof v==='string')}catch{};const res = NextResponse.json({ ok: true, id: Number(u.id), username: u.username, name: u.name, role: u.role, mode, company, menu_access: menuAccess, card_access:cardAccess });
    res.cookies.set(COOKIE, signSession(u.username, u.role, companyId, mode, menuAccess, cardAccess), cookieOptions(req));
    return res;
  } catch (e: any) {
    await recordFailure(key);
    return NextResponse.json({ error: String(e?.message || 'Invalid username or password') }, { status: 401 });
  }
}

export const runtime = 'nodejs';

const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST,{scope:'admin'});
export async function POST(req: Request) { return __wrapped_POST(req); }
