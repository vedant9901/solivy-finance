import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { db, adminDb, sessionMode } from '../../../../lib/db';
import { diagnose, repair, mirrorParties } from '../../../../lib/data-health';

/**
 * Administrator data health.
 *  GET  → dry-run diagnosis (no writes).
 *  POST {action, ids|'all', confirm:true} → applies ONE named repair, audited by the route guard.
 *  POST {action:'mirror_parties'} → explicit cross-organization master copy (was GET ?sync_parties=1).
 */
function adminOnly(req: Request) {
  if (req.headers.get('x-aksh-role') !== 'ADMIN') return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });
  return null;
}

async function getHandler(req: Request) {
  const denied = adminOnly(req); if (denied) return denied;
  const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1));
  return NextResponse.json({ ok: true, dry_run: true, ...diagnose(d) });
}

async function postHandler(req: Request) {
  const denied = adminOnly(req); if (denied) return denied;
  try {
    const x = await req.json();
    const mode = sessionMode(req); const companyId = Number(req.headers.get('x-aksh-company-id') || 1);
    const d = db(mode, companyId);
    if (x.action === 'mirror_parties') {
      const user = adminDb().prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(String(req.headers.get('x-aksh-user') || '')) as any;
      const sources = (adminDb().prepare(`SELECT c.id,c.name FROM companies c JOIN user_companies uc ON uc.company_id=c.id WHERE uc.user_id=? AND c.active=1 AND c.id<>? AND ${mode === 'TEST' ? 'uc.can_test=1' : 'uc.can_live=1'} ORDER BY c.name`).all(user?.id || 0, companyId) as any[])
        .map((c) => ({ id: Number(c.id), name: String(c.name), db: db(mode, Number(c.id)) }));
      return NextResponse.json({ ok: true, ...mirrorParties(d, sources) });
    }
    if (x.confirm !== true) return NextResponse.json({ error: 'Set confirm:true after reviewing the dry-run (GET).' }, { status: 400 });
    const ids = x.ids === 'all' ? 'all' : (Array.isArray(x.ids) ? x.ids.map(Number).filter(Number.isSafeInteger) : []);
    if (ids !== 'all' && !ids.length) return NextResponse.json({ error: 'Provide ids or "all".' }, { status: 400 });
    const affected = repair(d, String(x.action), ids);
    return NextResponse.json({ ok: true, action: x.action, affected });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
}

export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge(getHandler);
const __wrapped_POST = withPostgresSQLiteBridge(postHandler, { scope: 'all-mode' });
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
