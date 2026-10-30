import crypto from 'node:crypto';

/**
 * Change watermarks used for conditional API responses (ETag / 304).
 *
 * Every table a screen reads carries trigger-based change capture into sync_changes (lib/db.ts
 * ensureSyncSchema), so the highest sequence there moves on every insert, update and delete of
 * company data. Rows applied by a synchronisation pull are written with the triggers suppressed,
 * so the applied-event table is included as well, and the schema version covers upgrades. The
 * result identifies the state of the data exactly: if anything a report or screen could read has
 * changed, the watermark differs and the client refetches. Nothing is served from a cache without
 * matching it, so no stale balance, payment, receipt or purchase can be returned.
 */
type DB = any;
const one = (d: DB, sql: string, fallback: string | number = 0) => { try { const r = d.prepare(sql).get() as any; const v = r ? Object.values(r)[0] : fallback; return v === null || v === undefined ? fallback : v; } catch { return fallback; } };

export function companyWatermark(d: DB): string {
  const seq = one(d, 'SELECT COALESCE(MAX(seq),0) v FROM sync_changes');
  const applied = one(d, 'SELECT COALESCE(MAX(rowid),0) v FROM sync_applied_events');
  const pruned = one(d, 'SELECT COALESCE(pruned_through_seq,0) v FROM sync_meta WHERE id=1');
  let userVersion = 0; try { userVersion = Number(d.pragma('user_version', { simple: true })) || 0; } catch {}
  return `${seq}.${applied}.${pruned}.${userVersion}`;
}

export function adminWatermark(a: DB): string {
  const parts = [
    one(a, 'SELECT COUNT(*)||":"||COALESCE(MAX(rowid),0) v FROM admin_users', '0:0'),
    one(a, 'SELECT COUNT(*)||":"||COALESCE(MAX(rowid),0) v FROM companies', '0:0'),
    one(a, 'SELECT COUNT(*)||":"||COALESCE(MAX(rowid),0) v FROM user_companies', '0:0'),
    one(a, 'SELECT COALESCE(MAX(id),0) v FROM admin_audit_logs'),
    one(a, 'SELECT COALESCE(MAX(sessions_revoked_at),0) v FROM admin_users'),
    one(a, "SELECT COALESCE(SUM(length(COALESCE(menu_access,'')||COALESCE(card_access,''))),0) v FROM admin_users"),
  ];
  return parts.join('.');
}

/** Strong ETag over the data watermarks plus everything else that shapes the response. */
export function etagFor(parts: Array<string | number | undefined | null>): string {
  return `"${crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 32)}"`;
}

/** True when the client already holds this exact representation. */
export function notModified(req: Request, etag: string): boolean {
  const header = req.headers.get('if-none-match');
  if (!header) return false;
  return header.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}`);
}

export const NOT_MODIFIED_HEADERS = (etag: string) => ({ etag, 'cache-control': 'private, no-cache, max-age=0, must-revalidate' });

/**
 * Wrap a JSON GET handler with a conditional response. `parts` must include every input that
 * shapes the body (watermarks, identity, permissions, query parameters). The handler runs only
 * when the client is not already current, and its body is returned with the ETag attached.
 */
export async function conditionalJson(req: Request, parts: Array<string | number | undefined | null>, run: () => Promise<Response> | Response): Promise<Response> {
  const etag = etagFor(parts);
  if (notModified(req, etag)) return new Response(null, { status: 304, headers: NOT_MODIFIED_HEADERS(etag) });
  const res = await run();
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(NOT_MODIFIED_HEADERS(etag))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
