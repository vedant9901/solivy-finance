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


const SOLIVY_LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAInUktjI0jjuAmYTDfkOjKCiVopMVI3Gaa4cmxnwV1PQ=';
async function validateLicenseToken(token: string, companyId: number): Promise<{ok: boolean; reason?: string; payload?: any}> {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 2) return { ok: false, reason: 'License token format is invalid.' };
    const payloadBytes = base64(parts[0]);
    const signature = base64(parts[1]);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (payload.product !== 'SOLIVY_FINANCE' || !payload.licenseId || !payload.customer) return { ok: false, reason: 'License is not for SOLIVY Finance.' };
    const issued = Date.parse(payload.issuedAt), perpetual = payload.perpetual === true && payload.expiresAt === null, expires = perpetual ? Number.POSITIVE_INFINITY : Date.parse(payload.expiresAt);
    if (!Number.isFinite(issued) || issued > Date.now() + 5 * 60 * 1000) return { ok: false, reason: 'License issue date is invalid.' };
    if (!perpetual && !Number.isFinite(expires)) return { ok: false, reason: 'License expiry date is invalid.' };
    const key = await crypto.subtle.importKey('spki', base64(SOLIVY_LICENSE_PUBLIC_KEY), { name: 'Ed25519' } as AlgorithmIdentifier, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' } as AlgorithmIdentifier, key, signature, new TextEncoder().encode(parts[0]));
    if (!valid) return { ok: false, reason: 'License signature is invalid.' };
    if (!perpetual && expires <= Date.now()) return { ok: false, reason: 'License has expired. Contact the SOLIVY Team to renew it.' };
    if (!Array.isArray(payload.companyIds) || !(payload.companyIds.includes('*') || payload.companyIds.map(Number).includes(Number(companyId)))) return { ok: false, reason: 'This license is not assigned to the selected organization.' };
    return { ok: true, payload };
  } catch { return { ok: false, reason: 'License could not be validated.' }; }
}
function requiredFeatureForPath(path: string): string {
  const rules: Array<[string, string]> = [
    ['/api/accounts','accounts'], ['/api/account-movements','account-movements'],
    ['/api/parties','parties'], ['/api/third-parties','parties'], ['/api/parties-delete','parties'],
    ['/api/purchases','purchase'], ['/api/purchase-bill','purchase'],
    ['/api/payments','payments'], ['/api/payment-advice','payments'], ['/api/reverse','payments'],
    ['/api/money-in','money-in'], ['/api/receipts','money-in'], ['/api/sales','receivables'],
    ['/api/interest-payments','interest'], ['/api/funding','funding'], ['/api/import-finance','import'],
    ['/api/export/ledger','ledger'], ['/api/receivables','receivables'], ['/api/bank','bank'],
    ['/api/backup','backup'], ['/api/admin-backup-all','backup'], ['/api/export/gst','gst'],
    ['/api/export/payments','reports'], ['/api/export/purchases','reports'], ['/api/document-settings','document-settings'],
    ['/api/settings','settings'], ['/api/tds-check','payments'], ['/api/test-to-live','backup'],
    ['/api/data','dashboard'],
  ];
  const match = rules.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'));
  return match?.[1] || 'core';
}
function licenseFeatureAllowed(payload: any, feature: string): boolean {
  const features = Array.isArray(payload?.features) ? payload.features.map((x: unknown) => String(x)) : [];
  return features.includes('*') || features.includes(feature);
}

async function checkLicense(companyId: number): Promise<{ok: boolean; reason?: string; payload?: any; disabled?: boolean}> {
  const mode = (process.env.SOLIVY_LICENSE_ENFORCEMENT || 'off').toLowerCase();
  if (mode !== 'required') return { ok: true, disabled: true };
  let token = process.env.SOLIVY_LICENSE_TOKEN?.trim() || '';
  const mapText = process.env.SOLIVY_LICENSES_JSON?.trim();
  if (mapText) { try { const map = JSON.parse(mapText); token = String(map[String(companyId)] || map['*'] || token || ''); } catch { return { ok: false, reason: 'SOLIVY_LICENSES_JSON is not valid JSON.' }; } }
  if (!token) return { ok: false, reason: 'No license is configured for this organization. Contact the SOLIVY Team.' };
  return validateLicenseToken(token, companyId);
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const publicPath = path === '/login' || path === '/setup' || path === '/api/setup' || path === '/api/login' || path === '/api/login-companies' || path === '/forgot-password' || path === '/reset-password' || path === '/license' || path === '/api/license/status' || path === '/api/forgot-password' || path === '/api/reset-password' || path === '/api/logout' || path.startsWith('/_next/') || path === '/favicon.ico';
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

  const license = await checkLicense(Number(session.c));
  if (!license.ok) {
    // Keep the administrator able to sign in and reach License Management for renewal.
    // Financial APIs remain blocked below; this exception only opens the app shell.
    const adminLicenseRecovery = session.r === 'ADMIN' && path === '/';
    if (!adminLicenseRecovery) {
      if (path.startsWith('/api/')) return securityHeaders(NextResponse.json({ error: license.reason, code: 'LICENSE_REQUIRED' }, { status: 402 }), req);
      const target = new URL('/license', req.url);
      target.searchParams.set('reason', String(license.reason || 'License required'));
      return securityHeaders(NextResponse.redirect(target), req);
    }
  }
  if (!(session.r === 'ADMIN' && path === '/') && license.ok && !license.disabled && !licenseFeatureAllowed(license.payload, requiredFeatureForPath(path))) {
    const message = 'This module is not included in your SOLIVY license. Contact the SOLIVY Team to upgrade.';
    if (path.startsWith('/api/')) return securityHeaders(NextResponse.json({ error: message, code: 'LICENSE_FEATURE_LOCKED' }, { status: 403 }), req);
    const target = new URL('/license', req.url); target.searchParams.set('reason', message);
    return securityHeaders(NextResponse.redirect(target), req);
  }

  const denied = authorizeRequest(req, String(session.r || ''), session);
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
