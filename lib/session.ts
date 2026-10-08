import crypto from 'crypto';

export const COOKIE = 'aksh_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function getSecret() {
  const value = process.env.SESSION_SECRET?.trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be configured in production');
  }
  return 'aksh-local-dev-secret-change-this';
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  try {
    const [salt, hex] = String(stored || '').split(':');
    if (!salt || !hex) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function signSession(username: string, role: string, companyId: number, mode: 'LIVE' | 'TEST' = 'LIVE') {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    u: username,
    r: role,
    c: companyId,
    m: mode,
    i: now,
    e: now + SESSION_TTL_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined) {
  try {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const x = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!x?.u || !x?.r || !Number.isFinite(Number(x.c)) || !['LIVE', 'TEST'].includes(x.m) || Number(x.e) <= Date.now()) return null;
    return x;
  } catch {
    return null;
  }
}

export function cookieOptions(req: Request) {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = forwardedProto === 'https' || new URL(req.url).protocol === 'https:';
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}
