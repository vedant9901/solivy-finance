'use client';

/**
 * Shared browser request layer (v2.7.1).
 *
 * - DEDUPLICATED: concurrent identical GETs share one request, so a re-render or two components
 *   asking for the same thing cost one round trip.
 * - CONDITIONAL: every cached entry carries the ETag the server issued and is only reused after the
 *   server answers 304. Financial data is therefore never read from a stale cache, while
 *   revisiting a screen costs about 1 KB instead of the whole payload.
 * - ABORTABLE: `group` cancels the obsolete request when a newer one supersedes it (filter changes,
 *   fast tab switching), so abandoned work stops transferring.
 * - SCOPED: cache keys carry organization and environment, so LIVE and TEST, and one organization
 *   and another, can never share an entry.
 */
type Entry = { etag: string; body: any };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<any>>();
const controllers = new Map<string, AbortController>();

export function cacheScope() {
  try { return `${sessionStorage.getItem('aksh-company-id') || ''}:${sessionStorage.getItem('aksh-login-mode') || ''}`; } catch { return ''; }
}

/** Drop everything cached for the current organization/environment (after a mutation). */
export function invalidateClientCache() {
  const scope = cacheScope();
  for (const k of [...cache.keys()]) if (k.startsWith(scope)) cache.delete(k);
}

export async function getJson(url: string, opt: RequestInit & { group?: string; noCache?: boolean } = {}): Promise<any> {
  const key = `${cacheScope()}|${url}`;
  if (!opt.noCache) { const share = inflight.get(key); if (share) return share; }
  if (opt.group) { controllers.get(opt.group)?.abort(); }
  const controller = new AbortController();
  if (opt.group) controllers.set(opt.group, controller);
  const cached = opt.noCache ? undefined : cache.get(key);
  const run = (async () => {
    try {
      const r = await fetch(url, {
        cache: 'no-store', signal: controller.signal, ...opt,
        headers: { 'content-type': 'application/json', ...(cached ? { 'If-None-Match': cached.etag } : {}), ...(opt.headers || {}) },
      });
      if (r.status === 304 && cached) return cached.body;
      const j = await r.json().catch(() => ({ error: `Unexpected response (${r.status})` }));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      const etag = r.headers.get('etag');
      if (etag && (opt.method || 'GET').toUpperCase() === 'GET' && !opt.noCache) cache.set(key, { etag, body: j });
      return j;
    } finally {
      inflight.delete(key);
      if (opt.group && controllers.get(opt.group) === controller) controllers.delete(opt.group);
    }
  })();
  if (!opt.noCache) inflight.set(key, run);
  return run;
}

/** POST/PUT/PATCH/DELETE: never cached, and the organization's cached reads are dropped afterwards. */
export async function sendJson(url: string, body: any, method = 'POST'): Promise<any> {
  const r = await fetch(url, { method, cache: 'no-store', headers: { 'content-type': 'application/json', 'Idempotency-Key': newKey() }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `Unexpected response (${r.status})` }));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  invalidateClientCache();
  return j;
}

function newKey() { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; } }
