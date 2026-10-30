import crypto from 'node:crypto';
import { adminDb, db } from './db';
import { beginRequest, recordRequest } from './transfer-metrics';
import { effectiveAccess } from './api-access';

/** True when the PostgreSQL bridge is handling this request (it records metrics itself). */
function isOnlineBridge() { return process.env.SOLIVY_SQLITE_BRIDGE === '1'; }

/**
 * Server-side guard applied to every API route (online and offline) through
 * withPostgresSQLiteBridge(). Middleware has already verified the signed cookie;
 * this layer adds the checks that need the database:
 *  1. Session revocation: user still active, role unchanged, still granted this
 *     organization/environment, and the session was issued after the last revocation.
 *  2. Idempotency: a mutating request carrying `Idempotency-Key` is executed at most once;
 *     retries replay the stored response. The key row lives in the same SQLite file as the
 *     business write, so online both are persisted (or lost) together.
 *  3. Audit: every successful mutation is written to audit_logs (organization) or
 *     admin_audit_logs (administration), with secrets redacted.
 */
export type RouteGuardOptions = {
  /** Route only uses admin.db (no organization database available). */
  adminScope?: boolean;
  /** Disable the central audit entry (route writes its own richer entry). Default: audit on. */
  audit?: boolean;
  /** Skip the session revocation check (public/device routes). */
  skipSessionCheck?: boolean;
};

type Handler = (req: Request, ...args: any[]) => Promise<Response> | Response;
/** Routes whose edits (body.id present) are audited with a field-level before/after diff. */
const EDIT_TABLES: Record<string, string> = { '/api/purchases': 'purchases', '/api/payments': 'payments', '/api/sales': 'sales', '/api/parties': 'parties', '/api/accounts': 'company_accounts', '/api/funding': 'funding_loans', '/api/third-parties': 'third_parties', '/api/receivables': 'financing_receivables', '/api/saudas': 'saudas', '/api/godowns': 'godowns' };
const SECRET_KEYS = /pass(word)?|secret|token|otp|pin|signature|private/i;

function redact(value: any, depth = 0): any {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') { const out: any = {}; for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1); return out; }
  if (typeof value === 'string' && value.length > 300) return value.slice(0, 300) + '…';
  return value;
}

export function sessionDenied(req: Request): Response | null {
  const username = String(req.headers.get('x-aksh-user') || '');
  const role = String(req.headers.get('x-aksh-role') || '');
  const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
  const mode = req.headers.get('x-aksh-mode') === 'TEST' ? 'TEST' : 'LIVE';
  const iat = Number(req.headers.get('x-aksh-session-iat') || 0);
  const deny = (msg: string) => Response.json({ error: msg, code: 'SESSION_REVOKED' }, { status: 401 });
  let a;
  try { a = adminDb(); } catch { return null; } // storage unavailable: let the route report its own error
  const u = a.prepare('SELECT id,role,active,sessions_revoked_at FROM admin_users WHERE username=?').get(username) as any;
  if (!u || !Number(u.active)) return deny('Your account is no longer active. Sign in again or contact your administrator.');
  if (String(u.role) !== role) return deny('Your role was changed by an administrator. Sign in again.');
  if (iat && Number(u.sessions_revoked_at || 0) > iat) return deny('Your session was ended by an administrator or a password change. Sign in again.');
  if (companyId) {
    const g = a.prepare('SELECT uc.can_live,uc.can_test,c.active FROM user_companies uc JOIN companies c ON c.id=uc.company_id WHERE uc.user_id=? AND uc.company_id=?').get(u.id, companyId) as any;
    if (!g || !Number(g.active) || (mode === 'LIVE' ? !Number(g.can_live) : !Number(g.can_test))) return deny(`You no longer have ${mode} access to this organization. Sign in again.`);
  }
  return null;
}

function companyDb(req: Request) {
  const mode = req.headers.get('x-aksh-mode') === 'TEST' ? 'TEST' : 'LIVE';
  return db(mode, Number(req.headers.get('x-aksh-company-id') || 1));
}

function entityIdFrom(json: any, body: any): string | null {
  for (const k of ['id', 'paymentId', 'payment_id', 'receiptId', 'receipt_id', 'partyId', 'purchase_id', 'sale_id', 'loan_id']) {
    const v = json?.[k] ?? body?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return null;
}

export function guardedHandler(handler: Handler, opts: RouteGuardOptions = {}): Handler {
  return async (req: Request, ...args: any[]) => {
    const method = req.method.toUpperCase();
    // Offline installs have no bridge to account for transfer, so the same counters are kept in
    // memory here for the diagnostics screen (online mode records them in the bridge instead).
    const offlineMetrics = !isOnlineBridge();
    const startedAt = offlineMetrics ? beginRequest() : 0;
    const record = (res: Response) => {
      if (!offlineMetrics) return res;
      try { recordRequest({ url: req.url, method, status: res.status, companyId: Number(req.headers.get('x-aksh-company-id') || 0), mode: req.headers.get('x-aksh-mode') === 'TEST' ? 'TEST' : 'LIVE', requestBytes: Number(req.headers.get('content-length') || 0), responseBytes: Number(res.headers.get('content-length') || 0), startedAt, cached: res.status === 304 }); } catch {}
      return res;
    };
    const url = new URL(req.url);
    const authenticated = req.headers.get('x-aksh-authenticated') === '1' && Boolean(req.headers.get('x-aksh-user'));
    if (authenticated && !opts.skipSessionCheck) { const denied = sessionDenied(req); if (denied) return denied; }
    // A route declared READ changes nothing, so it gets no audit row and no idempotency key even
    // when it is a POST (a calculation check, for example). lib/api-access.ts is the declaration.
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method) && effectiveAccess(req.url, method).access === 'WRITE';
    if (!mutating) return record(await handler(req, ...args));

    const raw = Buffer.from(await req.clone().arrayBuffer());
    const isJson = (req.headers.get('content-type') || '').includes('json');
    let body: any = null;
    if (isJson) { try { body = JSON.parse(raw.toString('utf8') || 'null'); } catch {} }
    const username = String(req.headers.get('x-aksh-user') || '');
    const idemKey = String(req.headers.get('idempotency-key') || '').trim();
    const useIdem = authenticated && !opts.adminScope && idemKey.length > 0;
    let d: any = null;
    if (useIdem) {
      if (idemKey.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(idemKey)) return Response.json({ error: 'Invalid Idempotency-Key.' }, { status: 400 });
      d = companyDb(req);
      const hash = crypto.createHash('sha256').update(`${method} ${url.pathname}\n`).update(raw).digest('hex');
      d.prepare("DELETE FROM idempotency_keys WHERE created_at < datetime('now','-7 days')").run();
      const existing = d.prepare('SELECT * FROM idempotency_keys WHERE idem_key=?').get(idemKey) as any;
      if (existing) {
        if (existing.username !== username || existing.route !== url.pathname || existing.request_hash !== hash) return Response.json({ error: 'This Idempotency-Key was already used for a different request.', code: 'IDEMPOTENCY_KEY_REUSED' }, { status: 409 });
        if (existing.status === 'COMPLETE') return new Response(existing.response_body, { status: existing.response_status, headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' } });
        return Response.json({ error: 'This request is already being processed or its outcome is unknown. Check the register before posting again.', code: 'IDEMPOTENCY_IN_PROGRESS' }, { status: 409 });
      }
      d.prepare("INSERT INTO idempotency_keys(idem_key,route,username,request_hash,status) VALUES(?,?,?,?,'PENDING')").run(idemKey, url.pathname, username, hash);
    }

    const editTable = authenticated && !opts.adminScope && body && Number(body.id) > 0 ? EDIT_TABLES[url.pathname] : undefined;
    let beforeRow: any = null;
    if (editTable) { try { beforeRow = companyDb(req).prepare(`SELECT * FROM ${editTable} WHERE id=?`).get(Number(body.id)); } catch {} }
    let res: Response;
    try { res = await handler(req, ...args); }
    catch (e) { if (useIdem) d.prepare('DELETE FROM idempotency_keys WHERE idem_key=?').run(idemKey); throw e; }

    const ok = res.status < 400;
    let text: string | null = null;
    if (useIdem || ok) { try { text = await res.clone().text(); } catch { text = null; } }
    if (useIdem) {
      if (ok) d.prepare("UPDATE idempotency_keys SET status='COMPLETE',response_status=?,response_body=?,completed_at=CURRENT_TIMESTAMP WHERE idem_key=?").run(res.status, text ?? '', idemKey);
      else d.prepare('DELETE FROM idempotency_keys WHERE idem_key=?').run(idemKey);
    }
    if (ok && opts.audit !== false && (authenticated || url.pathname === '/api/login' || url.pathname === '/api/setup' || url.pathname === '/api/reset-password')) {
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
      const entity = url.pathname.replace(/^\/api\//, '');
      const action = `${changesLabel(editTable, beforeRow)}${method}${body?.action ? ':' + String(body.action).slice(0, 40) : body?.type ? ':' + String(body.type).slice(0, 40) : ''}`;
      let changes: Record<string, [any, any]> | undefined;
      if (editTable && beforeRow) {
        try { const after = companyDb(req).prepare(`SELECT * FROM ${editTable} WHERE id=?`).get(Number(body.id)) as any; changes = {}; for (const k of Object.keys({ ...beforeRow, ...(after || {}) })) if (String(beforeRow[k] ?? '') !== String(after?.[k] ?? '')) changes[k] = [beforeRow[k] ?? null, after?.[k] ?? null]; } catch {}
      }
      const details = JSON.stringify({ status: res.status, ...(changes ? { changes } : {}), request: isJson ? redact(body) : { content_type: req.headers.get('content-type'), bytes: raw.length }, idempotency_key: idemKey || undefined }).slice(0, 8000);
      try {
        if (opts.adminScope || !authenticated) {
          const who = authenticated ? username : String(body?.username || 'anonymous').slice(0, 80);
          adminDb().prepare('INSERT INTO admin_audit_logs(username,action,entity,entity_id,company_id,mode,details) VALUES(?,?,?,?,?,?,?)')
            .run(who, action, entity, entityIdFrom(json, body), Number(req.headers.get('x-aksh-company-id') || body?.company_id || 0) || null, req.headers.get('x-aksh-mode') || body?.mode || null, details);
        } else {
          companyDb(req).prepare('INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES(?,?,?,?,?)').run(username, action, entity, entityIdFrom(json, body), details);
        }
      } catch (e) { console.error('SOLIVY audit write failed', e); }
    }
    return record(res);
  };
}

function changesLabel(t?: string, before?: any) { return t && before ? 'EDIT ' : ''; }
