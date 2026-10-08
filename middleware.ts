import { NextRequest, NextResponse } from 'next/server';
const COOKIE = 'aksh_session';
import { authorizeRequest, securityHeaders } from './lib/security';

const secretFallback = 'aksh-local-dev-secret-change-this';

async function valid(token: string | undefined) {
  try {
    const secret = process.env.SESSION_SECRET?.trim() || (process.env.NODE_ENV === 'production' ? '' : secretFallback);
    if (!secret || !token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, base64(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const x = JSON.parse(new TextDecoder().decode(base64(payload)));
    if (!x?.u || !x?.r || !Number.isFinite(Number(x.c)) || !['LIVE', 'TEST'].includes(x.m) || Number(x.e) <= Date.now()) return null;
    return x;
  } catch { return null; }
}

function base64(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const publicPath = path === '/login' || path === '/api/login' || path === '/api/login-companies' || path === '/api/logout' || path.startsWith('/_next/') || path === '/favicon.ico';
  if (publicPath) {
    const res = NextResponse.next();
    return securityHeaders(res, req);
  }

  const session = await valid(req.cookies.get(COOKIE)?.value);
  if (!session) {
    const res = path.startsWith('/api/')
      ? NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
      : NextResponse.redirect(new URL('/login', req.url));
    return securityHeaders(res, req);
  }

  const denied = authorizeRequest(req, String(session.r || ''));
  if (denied) return securityHeaders(denied, req);

  if (path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
    const contentLength = Number(req.headers.get('content-length') || 0);
    const limit = path === '/api/import-finance' ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
    if (contentLength > limit) {
      return securityHeaders(NextResponse.json({ error: 'Request body is too large.' }, { status: 413 }), req);
    }
  }

  const requestedMode = req.headers.get('x-aksh-mode') || req.nextUrl.searchParams.get('mode');
  if (path.startsWith('/api/') && requestedMode && requestedMode !== String(session.m || 'LIVE') && !(session.r === 'ADMIN' && path === '/api/backup')) {
    return securityHeaders(NextResponse.json({ error: `Session is in ${session.m || 'LIVE'} mode. Switch environment before accessing ${requestedMode}.` }, { status: 403 }), req);
  }

  const h = new Headers(req.headers);
  h.set('x-aksh-company-id', String(session.c));
  h.set('x-aksh-role', String(session.r));
  h.set('x-aksh-user', String(session.u));
  h.set('x-aksh-mode', String(session.m));
  const res = NextResponse.next({ request: { headers: h } });
  return securityHeaders(res, req);
}

export const config = { matcher: ['/((?!_next/static|_next/image).*)'] };
