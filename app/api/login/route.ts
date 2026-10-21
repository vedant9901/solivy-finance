import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/db';
import { postgresPool, usesPostgres } from '../../../lib/postgres';
import { signSession, COOKIE, hashPassword, verifyPassword, cookieOptions } from '../../../lib/session';
import { checkLoginRateLimit, clearLoginFailures, loginRateLimitKey, recordLoginFailure } from '../../../lib/security';

async function __bridge_POST(req: Request) {
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

    let u: any;
    let company: any;
    let allowed: any;
    let legacyPasswordUpgrade = false;

    if (usesPostgres() && process.env.SOLIVY_NATIVE_PG_AUTH === '1') {
      // Online mode: use Neon only; never import/open SQLite for authentication.
      const pool = postgresPool();
      const userResult = await pool.query(
        'SELECT id, username, name, role, active, password, password_hash, menu_access, card_access FROM public.admin_users WHERE username = $1 LIMIT 1',
        [username]
      );
      u = userResult.rows[0];
      if (!u || !(u.active === true || u.active === 1 || u.active === '1')) throw Error('Invalid username or password');
      if (u.role === 'TESTER' && mode !== 'TEST') throw Error('Invalid username or password');

      const allowedResult = await pool.query(
        'SELECT can_live, can_test FROM public.user_companies WHERE user_id = $1 AND company_id = $2 LIMIT 1',
        [u.id, companyId]
      );
      allowed = allowedResult.rows[0];
      if (!allowed || ((mode === 'LIVE' && !(allowed.can_live === true || allowed.can_live === 1 || allowed.can_live === '1')) ||
          (mode === 'TEST' && !(allowed.can_test === true || allowed.can_test === 1 || allowed.can_test === '1')))) {
        throw Error('Invalid username or password');
      }

      let ok = verifyPassword(supplied, u.password_hash);
      if (!ok && u.password && supplied === String(u.password)) {
        ok = true;
        legacyPasswordUpgrade = true;
      }
      if (!ok) throw Error('Invalid username or password');

      if (legacyPasswordUpgrade) {
        await pool.query('UPDATE public.admin_users SET password_hash = $1, password = $2 WHERE id = $3', [hashPassword(supplied), '', u.id]);
      }
      const companyResult = await pool.query(
        'SELECT id, name, code, active FROM public.companies WHERE id = $1 AND active = 1 LIMIT 1',
        [companyId]
      );
      company = companyResult.rows[0];
    } else {
      const d = adminDb();
      u = d.prepare('SELECT id,username,name,role,active,password,password_hash,menu_access,card_access FROM admin_users WHERE username=?').get(username) as any;
      if (!u || !u.active) throw Error('Invalid username or password');
      if (u.role === 'TESTER' && mode !== 'TEST') throw Error('Invalid username or password');
      allowed = d.prepare('SELECT can_live,can_test FROM user_companies WHERE user_id=? AND company_id=?').get(u.id, companyId) as any;
      if (!allowed || ((mode === 'LIVE' && !allowed.can_live) || (mode === 'TEST' && !allowed.can_test))) throw Error('Invalid username or password');

      let ok = verifyPassword(supplied, u.password_hash);
      if (!ok && u.password && supplied === String(u.password)) {
        ok = true;
        d.prepare('UPDATE admin_users SET password_hash=?,password=? WHERE id=?').run(hashPassword(supplied), '', u.id);
      }
      if (!ok) throw Error('Invalid username or password');

      company = d.prepare('SELECT id,name,code,active FROM companies WHERE id=? AND active=1').get(companyId) as any;
    }
    if (!company) throw Error('Invalid username or password');
    clearLoginFailures(key);
    const defaultMenuIds=['dashboard','accounts','account-movements','parties','party-aliases','purchase','payments','money-in','interest','funding','import','ledger','receivables','reports','bank','backup','secondary-backup','tally-export','bank-statement-import','gst','commercial-bills','document-settings','settings','transfers','sync'];let menuAccess:string[]=u.role==='ADMIN'?defaultMenuIds:['dashboard'];try{const parsed=JSON.parse(String(u.menu_access||''));if(Array.isArray(parsed))menuAccess=parsed.filter((m:any)=>defaultMenuIds.includes(String(m)))}catch{}let cardAccess:string[]=u.role==='ADMIN'?['kpi-parties','kpi-purchase-cost','kpi-paid','kpi-vendor-outstanding','kpi-finance-profit','kpi-average-earning','business-pulse','due-pay-today','due-pay-tomorrow','due-receive-today','due-receive-tomorrow','due-interest-today','due-interest-tomorrow','due-this-week','overdue-receivables','bank-cash','realised-profit','charts']:[];try{const ca=JSON.parse(String(u.card_access||''));if(Array.isArray(ca))cardAccess=ca.filter((v:any)=>typeof v==='string')}catch{};const res = NextResponse.json({ ok: true, name: u.name, role: u.role, mode, company, menu_access: menuAccess, card_access:cardAccess });
    res.cookies.set(COOKIE, signSession(u.username, u.role, companyId, mode, menuAccess, cardAccess), cookieOptions(req));
    return res;
  } catch (e: any) {
    recordLoginFailure(key);
    return NextResponse.json({ error: String(e?.message || 'Invalid username or password') }, { status: 401 });
  }
}

export const runtime = 'nodejs';

const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST);
export async function POST(req: Request) { return __wrapped_POST(req); }
