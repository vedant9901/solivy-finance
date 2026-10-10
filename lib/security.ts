import { NextRequest, NextResponse } from 'next/server';

const loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

export function clientIp(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

export function loginRateLimitKey(req: Request, username: string) {
  return `${clientIp(req)}:${username.trim().toLowerCase().slice(0, 80)}`;
}

export function checkLoginRateLimit(key: string) {
  const now = Date.now();
  const state = loginAttempts.get(key);
  if (!state || now > state.resetAt) {
    loginAttempts.set(key, { count: 0, resetAt: now + WINDOW_MS, blockedUntil: 0 });
    return { allowed: true, retryAfter: 0 };
  }
  if (state.blockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((state.blockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const state = loginAttempts.get(key) || { count: 0, resetAt: now + WINDOW_MS, blockedUntil: 0 };
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + WINDOW_MS;
  }
  state.count += 1;
  if (state.count >= MAX_LOGIN_ATTEMPTS) state.blockedUntil = now + BLOCK_MS;
  loginAttempts.set(key, state);
}

export function clearLoginFailures(key: string) {
  loginAttempts.delete(key);
}

export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin) {
    try { return origin === new URL(req.url).origin; } catch { return false; }
  }
  const referer = req.headers.get('referer');
  if (referer) {
    try { return new URL(referer).origin === new URL(req.url).origin; } catch { return false; }
  }
  const fetchSite = req.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none';
}

export function securityHeaders(res: NextResponse, req: NextRequest) {
  const isHttps = req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.headers.set('X-DNS-Prefetch-Control', 'off');
  res.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  res.headers.set('Origin-Agent-Cluster', '?1');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  if (isHttps) res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return res;
}

const ADMIN_ONLY = new Set([
  '/api/admin',
  '/api/admin-backup-all',
  '/api/backup',
  '/api/document-settings',
  '/api/test-to-live',
  '/api/parties-delete',
  '/api/reverse',
]);

const ADMIN_WRITE_PREFIXES = ['/api/users'];
const ADMIN_WRITE_ROUTES = new Set(['/api/companies', '/api/settings']);
const ADMIN_DELETE_ROUTES = new Set(['/api/accounts']);

export function authorizeRequest(req: NextRequest, role: string, session?: any) {
  const path = req.nextUrl.pathname;
  const method = req.method.toUpperCase();
  if (!path.startsWith('/api/')) return null;
  if (path === '/api/login' || path === '/api/login-companies' || path === '/api/logout') return null;

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !sameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-site request blocked.' }, { status: 403 });
  }

  if (role === 'VIEWER' && !['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/api/switch-company' && path !== '/api/switch-environment') {
    return NextResponse.json({ error: 'Viewer access is read-only.' }, { status: 403 });
  }

  if (ADMIN_ONLY.has(path) && role !== 'ADMIN') {
    return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });
  }
  // Server-side menu entitlement checks. UI locks are only presentation; APIs enforce the same module IDs.
  if (role !== 'ADMIN') {
    const moduleRules: Array<[string, string[]]> = [
      ['/api/accounts', ['accounts']], ['/api/account-movements', ['account-movements']],
      ['/api/parties', ['parties']], ['/api/third-parties', ['parties']], ['/api/parties-delete', ['parties']],
      ['/api/purchases', ['purchase']], ['/api/purchase-bill', ['purchase']],
      ['/api/payments', ['payments']], ['/api/payment-advice', ['payments']],
      ['/api/money-in', ['money-in']], ['/api/receipts', ['money-in']], ['/api/sales', ['receivables']],
      ['/api/interest-payments', ['interest']], ['/api/funding', ['funding']],
      ['/api/import-finance', ['import']], ['/api/export/ledger', ['ledger']],
      ['/api/receivables', ['receivables']], ['/api/bank', ['bank']],
      ['/api/backup', ['backup']], ['/api/admin-backup-all', ['backup']],
      ['/api/export/gst', ['gst']], ['/api/export/payments', ['reports']], ['/api/export/purchases', ['reports']],
      ['/api/document-settings', ['document-settings']], ['/api/settings', ['settings']],
      ['/api/tds-check', ['payments']], ['/api/reverse', ['payments']], ['/api/test-to-live', ['backup']],
    ];
    const rule = moduleRules.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'));
    if (rule) {
      const allowed = Array.isArray(session?.a) ? session.a : [];
      if (!rule[1].some((id) => allowed.includes(id))) {
        return NextResponse.json({ error: 'This module is not included in your user access. Contact your SOLIVY administrator.' }, { status: 403 });
      }
    }
  }
  if (ADMIN_WRITE_ROUTES.has(path) && method !== 'GET' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });
  }
  if (ADMIN_DELETE_ROUTES.has(path) && method === 'DELETE' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });
  }
  if (ADMIN_WRITE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) && method !== 'GET' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });
  }
  return null;
}
