import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/db';
import { hashPassword } from '../../../lib/session';

const DEFAULT_MENU_IDS = ['dashboard','accounts','account-movements','parties','purchase','payments','money-in','interest','funding','import','ledger','receivables','reports','bank','backup','gst','commercial-bills','document-settings','settings'];

export async function GET() {
  try {
    const d = adminDb();
    const count = Number((d.prepare("SELECT COUNT(*) AS c FROM admin_users WHERE role='ADMIN' AND active=1").get() as any)?.c || 0);
    return NextResponse.json({ requiresSetup: count === 0 });
  } catch {
    return NextResponse.json({ error: 'Unable to inspect installation state.' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const expectedSetupSecret = String(process.env.SOLIVY_SETUP_SECRET || '').trim();
    const suppliedSetupSecret = String(body.setupSecret || '').trim();
    if (!expectedSetupSecret || suppliedSetupSecret.length < 24 || suppliedSetupSecret !== expectedSetupSecret) throw new Error('Initial setup authorization is missing or invalid. Use the setup key provided by your installer or deployment administrator.');
    const username = String(body.username || '').trim();
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) throw new Error('Username must be 3–60 characters and use letters, numbers, dots, underscores or hyphens.');
    if (name.length < 2 || name.length > 100) throw new Error('Enter the administrator name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid administrator email address.');
    if (password.length < 12 || password.length > 256) throw new Error('Use a password with at least 12 characters.');
    if (password !== confirmPassword) throw new Error('Passwords do not match.');

    const d = adminDb();
    const create = d.transaction(() => {
      const count = Number((d.prepare("SELECT COUNT(*) AS c FROM admin_users WHERE role='ADMIN' AND active=1").get() as any)?.c || 0);
      if (count !== 0) throw new Error('Initial setup has already been completed. Ask an existing administrator to create another user.');
      const company = d.prepare("SELECT id FROM companies WHERE code='SOLIVY' AND active=1 ORDER BY id LIMIT 1").get() as any;
      if (!company) throw new Error('No active default organization exists. Contact SOLIVY support.');
      const result = d.prepare('INSERT INTO admin_users(username,name,role,password,password_hash,active,menu_access,email) VALUES(?,?,\'ADMIN\',\'\',?,1,?,?)')
        .run(username, name, hashPassword(password), JSON.stringify(DEFAULT_MENU_IDS), email);
      d.prepare('INSERT INTO user_companies(user_id,company_id,can_live,can_test) VALUES(?,?,1,1)')
        .run(Number(result.lastInsertRowid), Number(company.id));
    });
    create();
    return NextResponse.json({ ok: true, message: 'Administrator created. Sign in using the credentials you just configured.' });
  } catch (e: any) {
    const msg = String(e?.message || 'Initial setup failed.');
    return NextResponse.json({ error: msg }, { status: /already been completed|setup authorization|Username|password|name|match|organization/i.test(msg) ? 400 : 500 });
  }
}
