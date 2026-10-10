import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { adminDb } from '../../../lib/db';
import { hashPassword } from '../../../lib/session';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const token = String(body.token || '');
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    if (token.length < 30 || token.length > 200) throw new Error('This reset link is invalid or expired. Request a new one.');
    if (password.length < 12 || password.length > 256) throw new Error('Use a password with at least 12 characters.');
    if (password !== confirmPassword) throw new Error('Passwords do not match.');
    const d = adminDb();
    const tokenHash = sha(token);
    const record = d.prepare(`SELECT id,user_id FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1`).get(tokenHash, new Date().toISOString()) as any;
    if (!record) throw new Error('This reset link is invalid or expired. Request a new one.');
    const change = d.transaction(() => {
      const current = d.prepare('SELECT active FROM admin_users WHERE id=?').get(record.user_id) as any;
      if (!current?.active) throw new Error('This account is inactive. Contact your administrator.');
      d.prepare("UPDATE admin_users SET password='',password_hash=? WHERE id=?").run(hashPassword(password), record.user_id);
      d.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL').run(record.user_id);
    });
    change();
    return NextResponse.json({ ok: true, message: 'Password changed. Sign in with your new password.' });
  } catch (e: any) {
    const message = String(e?.message || 'Unable to reset password.');
    return NextResponse.json({ error: message }, { status: /invalid|expired|password|match|inactive/i.test(message) ? 400 : 500 });
  }
}
