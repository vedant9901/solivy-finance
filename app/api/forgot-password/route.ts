import { NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { adminDb } from '../../../lib/db';

const generic = 'If the account and organization match, recovery instructions will be sent to the registered organization and SOLIVY administrator email addresses.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const username = String(body.username || '').trim();
    const organization = String(body.company || '').trim();
    if (!username || !organization || username.length > 80 || organization.length > 100) {
      return NextResponse.json({ message: generic }, { status: 200 });
    }
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.MAIL_FROM?.trim();
    const adminEmail = process.env.SOLIVY_ADMIN_EMAIL?.trim().toLowerCase();
    const baseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, '');
    if (!apiKey || !from || !adminEmail || !baseUrl) {
      return NextResponse.json({ error: 'Password recovery email is not configured. Contact your SOLIVY administrator.' }, { status: 503 });
    }
    const d = adminDb();
    const user = d.prepare(`SELECT u.id,u.username,u.email,c.id AS company_id,c.name AS company_name,c.code,c.email AS company_email
      FROM admin_users u JOIN user_companies uc ON uc.user_id=u.id JOIN companies c ON c.id=uc.company_id
      WHERE u.username=? AND u.active=1 AND (LOWER(c.code)=LOWER(?) OR LOWER(c.name)=LOWER(?)) AND c.active=1
      ORDER BY c.id LIMIT 1`).get(username, organization, organization) as any;
    if (!user || !user.company_email) return NextResponse.json({ message: generic }, { status: 200 });

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    d.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL').run(user.id);
    d.prepare('INSERT INTO password_reset_tokens(user_id,company_id,token_hash,expires_at) VALUES(?,?,?,?)').run(user.id, user.company_id, tokenHash, expiresAt);
    const link = `${baseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
    const recipients = Array.from(new Set([String(user.company_email).toLowerCase(), adminEmail]));
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: recipients, subject: `SOLIVY Finance password reset — ${user.company_name}`, text: `A password reset was requested for username ${user.username} in organization ${user.company_name}. This link expires in 30 minutes and can be used once: ${link}\n\nIf you did not request this, ignore this email.` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      d.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(tokenHash);
      return NextResponse.json({ error: 'The recovery email could not be sent. Contact your SOLIVY administrator.' }, { status: 502 });
    }
    return NextResponse.json({ message: generic }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'Unable to process recovery request. Contact your SOLIVY administrator.' }, { status: 500 });
  }
}
