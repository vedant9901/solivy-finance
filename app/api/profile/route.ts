import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/db';
import { hashPassword, verifyPassword } from '../../../lib/session';

async function __bridge_GET(req: Request) {
  try {
    const username = String(req.headers.get('x-aksh-user') || '').trim();
    const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
    if (!username || !companyId) throw Error('Authenticated user session required.');
    const d = adminDb();
    const u: any = d.prepare('SELECT id,username,name,role,active,menu_access FROM admin_users WHERE lower(username)=lower(?)').get(username);
    if (!u || !u.active) throw Error('User account is unavailable.');
    const co: any = d.prepare('SELECT id,name FROM companies WHERE id=?').get(companyId);
    if (!co) throw Error('Organization not found.');
    const modules = (() => { try { const v = JSON.parse(String(u.menu_access || '[]')); return Array.isArray(v) ? v.filter((x:any)=>typeof x==='string') : []; } catch { return []; } })();
    return NextResponse.json({ id: Number(u.id), username: u.username, name: u.name, role: u.role, organization: co.name, company_id: companyId, modules });
  } catch (e:any) { return NextResponse.json({ error: e.message || 'Could not load profile.' }, { status: 400 }); }
}

async function __bridge_POST(req: Request) {
  try {
    const username = String(req.headers.get('x-aksh-user') || '').trim();
    if (!username) throw Error('Authenticated user session required.');
    const body = await req.json();
    const current = String(body.current_password || '');
    const next = String(body.new_password || '');
    if (next.length < 12 || next.length > 256) throw Error('New password must be at least 12 characters.');
    if (next === current) throw Error('New password must be different from the current password.');
    const d = adminDb();
    const u: any = d.prepare('SELECT id,password,password_hash,active FROM admin_users WHERE lower(username)=lower(?)').get(username);
    if (!u || !u.active) throw Error('User account is unavailable.');
    let valid = verifyPassword(current, String(u.password_hash || ''));
    if (!valid && u.password && current === String(u.password)) valid = true;
    if (!valid) throw Error('Current password is incorrect.');
    d.prepare('UPDATE admin_users SET password_hash=?,password=? WHERE id=?').run(hashPassword(next), '', Number(u.id));
    return NextResponse.json({ ok: true, message: 'Password changed successfully.' });
  } catch (e:any) { return NextResponse.json({ error: e.message || 'Could not change password.' }, { status: 400 }); }
}
export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET,{scope:'admin'});
const __wrapped_POST = withPostgresSQLiteBridge(__bridge_POST,{scope:'admin'});
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
