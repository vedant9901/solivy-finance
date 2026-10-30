/**
 * End-to-end test harness: every call goes through the real middleware.ts
 * (session verification, license, RBAC, header injection) and then the real
 * route handler module, against real SQLite files in a temp directory.
 */
import path from 'node:path';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = 'http://localhost:3000';

export type CallOpts = { method?: string; body?: any; cookie?: string; headers?: Record<string, string>; query?: Record<string, any> };
export type CallResult = { status: number; json: any; text: string; headers: Headers; bytes: number; cookie?: string; buffer: Buffer };

const routeCache = new Map<string, any>();
async function routeModule(p: string) {
  if (!routeCache.has(p)) routeCache.set(p, await import(path.join(ROOT, 'app', p, 'route.ts')));
  return routeCache.get(p);
}

export async function call(p: string, opts: CallOpts = {}): Promise<CallResult> {
  const method = (opts.method || (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const url = new URL(BASE + p);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, String(v));
  const headers = new Headers({ origin: BASE, ...(opts.headers || {}) });
  if (opts.cookie) headers.set('cookie', `aksh_session=${opts.cookie}`);
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) body = opts.body;
    else { body = JSON.stringify(opts.body); headers.set('content-type', 'application/json'); headers.set('content-length', String(Buffer.byteLength(body))); }
  }
  const { middleware } = await import(path.join(ROOT, 'middleware.ts'));
  const req = new NextRequest(url, { method, headers, body });
  const mw: any = await middleware(req);
  let res: Response = mw;
  if (mw.__next) {
    const routePath = url.pathname;
    const mod = await routeModule(routePath);
    const handler = mod[method];
    if (!handler) return { status: 405, json: null, text: '', headers: new Headers(), bytes: 0, buffer: Buffer.alloc(0) };
    const forwarded = new Request(url, { method, headers: mw.__requestHeaders || headers, body: opts.body instanceof FormData ? opts.body : body });
    res = await handler(forwarded);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/aksh_session=([^;]*)/);
  return { status: res.status, json, text, headers: res.headers, bytes: buf.length, cookie: m ? m[1] : undefined, buffer: buf };
}

/** Create an organization and a user directly in admin.db (the same tables the Admin UI writes). */
export async function seedOrg(opts: { companyName?: string; code?: string } = {}) {
  const { adminDb } = await import(path.join(ROOT, 'lib', 'db.ts'));
  const d = adminDb();
  const code = opts.code || `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const r = d.prepare('INSERT INTO companies(name,code,active) VALUES(?,?,1)').run(opts.companyName || `Org ${code}`, code);
  return Number(r.lastInsertRowid);
}

export async function seedUser(opts: { username: string; password?: string; role?: string; companies: Array<{ id: number; live?: boolean; test?: boolean }>; menu?: string[] }) {
  const { adminDb } = await import(path.join(ROOT, 'lib', 'db.ts'));
  const { hashPassword } = await import(path.join(ROOT, 'lib', 'session.ts'));
  const d = adminDb();
  const r = d.prepare('INSERT INTO admin_users(username,name,role,password,password_hash,active,menu_access,card_access,email) VALUES(?,?,?,?,?,1,?,?,?)')
    .run(opts.username, opts.username, opts.role || 'ADMIN', '', hashPassword(opts.password || 'Correct-Horse-9'), JSON.stringify(opts.menu || []), '[]', `${opts.username}@example.test`);
  const id = Number(r.lastInsertRowid);
  for (const c of opts.companies) d.prepare('INSERT OR REPLACE INTO user_companies(user_id,company_id,can_live,can_test) VALUES(?,?,?,?)').run(id, c.id, c.live === false ? 0 : 1, c.test ? 1 : 0);
  return id;
}

export async function login(username: string, companyId: number, mode: 'LIVE' | 'TEST' = 'LIVE', password = 'Correct-Horse-9') {
  const r = await call('/api/login', { body: { username, password, company_id: companyId, mode } });
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed ${r.status} ${r.text}`);
  return r.cookie;
}

/** Convenience: an admin with one fresh organization, logged in. */
export async function adminSession(mode: 'LIVE' | 'TEST' = 'LIVE') {
  const companyId = await seedOrg();
  const username = `admin_${Math.random().toString(36).slice(2, 8)}`;
  await seedUser({ username, role: 'ADMIN', companies: [{ id: companyId, live: true, test: true }] });
  const cookie = await login(username, companyId, mode);
  return { companyId, username, cookie };
}

export function expectOk(r: CallResult, label = '') {
  if (r.status >= 400) throw new Error(`${label} HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r.json;
}

/** Headers a route handler receives after middleware (for invoking fixture/legacy handlers directly). */
export async function forwardedHeaders(p: string, cookie: string) {
  const { middleware } = await import(path.join(ROOT, 'middleware.ts'));
  const res: any = await middleware(new NextRequest(new URL(BASE + p), { headers: { cookie: `aksh_session=${cookie}`, origin: BASE } }));
  if (!res.__next) throw new Error(`middleware refused ${p}: ${res.status}`);
  return res.__requestHeaders as Headers;
}
