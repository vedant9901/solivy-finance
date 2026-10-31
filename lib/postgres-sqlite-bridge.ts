import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PoolClient } from 'pg';
import { postgresPool, usesPostgres } from './postgres';
import { closeAllDatabases, databasePath, adminDatabasePath, setBridgeScope, bridgeCreatedFiles, SCHEMA_VERSION } from './db';
import { guardedHandler, type RouteGuardOptions } from './route-guard';
import { pruneSyncJournal } from './sync-prune';
import { beginRequest, recordRequest, flushMetrics } from './transfer-metrics';
import { effectiveAccess, type AccessClass } from './api-access';
import { ensureTables, remoteVersions, materialize, writeSnapshot, backupSnapshot, sha256, CHUNK_SIZE, type LocalCopy } from './snapshot-store';
import { ensureProjectionTable, refreshLoginCompanies, projectionVersion } from './public-projection';

/**
 * SQLite-in-PostgreSQL bridge (v2.7.0) — online mode (Vercel + Neon).
 *
 * v2.6.30 downloaded and re-uploaded EVERY organization's LIVE and TEST file on EVERY request
 * (measured 12.9 MB down + 6.4 MB up per request with 3 organizations) under one global lock.
 * v2.7.0:
 *  - SCOPED: admin.db + only the files the route declares (default: session org, session env).
 *  - CACHED: a warm instance keeps its copy; only a version number is fetched per request.
 *  - DELTA: 16 KiB gzip chunks; reads fetch and writes upload only changed chunks
 *    (lib/snapshot-store.ts). Unchanged files are never written.
 *  - ATOMIC: all snapshot writes of a request commit in one PostgreSQL transaction.
 *  - CONCURRENCY: per-organization advisory locks (sorted → deadlock-free); admin.db is
 *    optimistic (version check) — a concurrent admin change returns 409 and saves nothing.
 *  - GUARDED: a file outside the declared scope cannot be opened, so a missing file can never
 *    be created empty and persisted over real data.
 *  - AUTH FIRST: device-token routes authorise against admin.db before org data is loaded;
 *    public routes (login, recovery) only ever load admin.db.
 */
const LOCK_NAMESPACE = 530202530;

export type BridgeScope = 'admin' | 'company' | 'company-both' | 'all-mode' | 'all';
export type BridgeOptions = RouteGuardOptions & {
  scope?: BridgeScope;
  allowCreate?: boolean;
  extraCompanies?: (req: Request, admin: Database.Database) => number[] | Promise<number[]>;
  /**
   * Exact extra files this request needs, decided from admin.db and the request only (v2.7.1).
   * Narrows routes that previously declared 'all'/'all-mode' and hydrated every organization:
   * returning [] means "the session organization only". Each entry is still authorised against
   * the caller's organization grants (administrators excepted) before it is loaded.
   */
  extraFiles?: (req: Request, admin: Database.Database) => Array<{ id: number; mode: 'LIVE' | 'TEST' }> | Promise<Array<{ id: number; mode: 'LIVE' | 'TEST' }>>;
  preAuthorize?: (req: Request, admin: Database.Database) => { companyId: number; mode: 'LIVE' | 'TEST' };
  /** Take the exclusive admin.db lock (routes that write administration data). Default: admin scope and device routes. */
  lockAdmin?: boolean;
  /** Route has external side effects (remote HTTP, e-mail): never auto-retry after a conflict. */
  noRetry?: boolean;
};
type RouteHandler = (req: Request, ...args: any[]) => Promise<Response> | Response;
type Entry = { key: string; file: string; locked: boolean };

const localCache: Map<string, LocalCopy> = (globalThis as any).__solivyBridgeCache ||= new Map();
/**
 * In-process serialisation. SQLite handles, the /tmp working copies and the scope guard are
 * process-wide, and an instance may serve concurrent requests (e.g. Vercel fluid compute), so
 * bridged requests run one at a time per process. Cross-instance safety comes from PG locks.
 */
/** Admin snapshot version whose login projection this process has already published. */
let publishedAdminVersion = '';
let lastMetricsFlush = 0;
let coalescedReads = 0;
let readPersistBlocked = 0;
let readSkippedNew = 0;
let lastReadViolation = '';
/** Diagnostics for the guards added in v2.7.2. */
/**
 * Keys whose online snapshot this request has already replaced itself (v2.9.0).
 *
 * The clone engine stages, verifies and activates a whole snapshot through its own PostgreSQL
 * client. The bridge must then not also upload the organization file it hydrated at the start of
 * the request: it holds the version from before the activation, so the write would be refused as a
 * concurrent update, and the file it holds is the pre-clone one. The clone marks the key here, the
 * bridge skips persisting it once, and the next request re-materialises from the new version.
 */
const snapshotReplaced = new Set<string>();
export function markSnapshotReplaced(companyId: number, mode: 'LIVE' | 'TEST') { snapshotReplaced.add(keyFor(companyId, mode)); }

export function bridgeGuardStats() { return { coalescedReads, readPersistBlocked, readSkippedNew, lastReadViolation }; }
export function resetBridgeGuardStats() { coalescedReads = 0; readPersistBlocked = 0; readSkippedNew = 0; lastReadViolation = ''; }
/**
 * Identical concurrent READ requests share one execution (v2.7.2). Two components, a re-render or
 * two browser tabs asking for the same URL with the same identity and the same conditional headers
 * produce one snapshot hydration and one response instead of two. The key carries organization,
 * environment, user, role, menu and If-None-Match, so no two callers with different authority or
 * different cached state can ever share a response.
 */
const inflightReads = new Map<string, Promise<Response>>();
function readKey(req: Request) {
  const h = req.headers;
  return [req.method, req.url, h.get('x-aksh-company-id'), h.get('x-aksh-mode'), h.get('x-aksh-user'), h.get('x-aksh-role'), h.get('x-aksh-menu'), h.get('x-aksh-session-iat'), h.get('if-none-match')].join('|');
}
let processQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = processQueue.then(fn, fn);
  processQueue = run.catch(() => undefined);
  return run;
}
class BridgeConflict extends Error { status = 409; code = 'CONCURRENT_UPDATE'; constructor(message: string, public scope: string) { super(message); } }

export function bridgeIsOnline() {
  return process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV) || Boolean(process.env.VERCEL_REGION) || process.cwd().replace(/\\/g, '/').startsWith('/var/task');
}
const keyFor = (id: number, mode: 'LIVE' | 'TEST') => `company:${id}:${mode}`;
function readUserVersion(file: string): number {
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 60); fs.closeSync(fd); return b.readUInt32BE(0); } catch { return 0; }
}

/** Ensure local files equal the current remote version, downloading only what changed. */
async function sync(client: PoolClient, entries: Entry[], state: Map<string, { copy: LocalCopy | null; userVersion: number; original?: Buffer }>) {
  const todo = entries.filter((e) => !state.has(e.key));
  if (!todo.length) return;
  const versions = await remoteVersions(client, todo.map((e) => e.key));
  const refresh: Array<{ key: string; file: string; local?: LocalCopy }> = [];
  for (const e of todo) {
    for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(e.file + s); } catch {} }
    const v = versions.get(e.key);
    const cached = localCache.get(e.key);
    if (v === undefined) { try { fs.unlinkSync(e.file); } catch {} localCache.delete(e.key); state.set(e.key, { copy: null, userVersion: 0 }); continue; }
    const intact = cached && fs.existsSync(e.file) && sha256(fs.readFileSync(e.file)) === cached.sha;
    if (cached && intact && cached.version === v) { state.set(e.key, { copy: cached, userVersion: readUserVersion(e.file) }); continue; }
    // Any existing local copy is a valid base for a chunk diff: the assembled file is verified
    // against the remote SHA-256 and fully re-downloaded on mismatch.
    refresh.push({ key: e.key, file: e.file, local: fs.existsSync(e.file) ? (cached || { version: '?', sha: '', manifest: [], chunkSize: CHUNK_SIZE }) : undefined });
  }
  const got = await materialize(client, refresh);
  for (const r of refresh) {
    const copy = got.get(r.key) ?? null;
    if (copy) localCache.set(r.key, copy); else localCache.delete(r.key);
    const uv = readUserVersion(r.file);
    state.set(r.key, { copy, userVersion: uv, original: copy && uv < SCHEMA_VERSION ? fs.readFileSync(r.file) : undefined });
  }
}

export function withPostgresSQLiteBridge(handler: RouteHandler, options: BridgeOptions = {}): (req: Request, ...args: any[]) => Promise<Response> {
  const scope = options.scope || 'company';
  const guarded = guardedHandler(handler, { ...options, adminScope: scope === 'admin' });
  return async (req: Request, ...args: any[]) => {
    if (!bridgeIsOnline()) return guarded(req, ...args);
    if (!usesPostgres()) return Response.json({ error: 'DATABASE_URL is required on Vercel. Configure a persistent PostgreSQL/Neon database before using SOLIVY Finance online.' }, { status: 503 });
    const { access } = effectiveAccess(req.url, req.method);
    if (access === 'NO_DB') return guarded(req, ...args);
    // Optimistic admin.db conflicts are retried transparently: nothing from the failed attempt
    // was saved, so re-running is safe. Routes with external side effects opt out (noRetry).
    const raw = ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? null : Buffer.from(await req.clone().arrayBuffer());
    const attempts = options.noRetry ? 1 : 3;
    const run = async () => {
      for (let attempt = 1; ; attempt++) {
        const r = new Request(req.url, { method: req.method, headers: req.headers, body: raw ? new Uint8Array(raw) : undefined });
        const res = await serialized(() => bridged(r, args, access));
        if (res.status !== 409 || attempt >= attempts || res.headers.get('x-solivy-conflict') !== 'admin') return res;
        await new Promise((ok) => setTimeout(ok, 20 + Math.random() * 60 * attempt));
      }
    };
    if (access !== 'READ') return run();
    const key = readKey(req);
    const shared = inflightReads.get(key);
    if (shared) { coalescedReads++; return (await shared).clone(); }
    const started = run().finally(() => { if (inflightReads.get(key) === started) inflightReads.delete(key); });
    inflightReads.set(key, started);
    return (await started).clone();
  };
  async function bridged(req: Request, args: any[], access: AccessClass): Promise<Response> {
    const startedAt = beginRequest();
    const client = await postgresPool().connect();
    const state = new Map<string, { copy: LocalCopy | null; userVersion: number; original?: Buffer }>();
    const entries: Entry[] = [];
    let response: Response | undefined;
    let responseBytes = 0;
    const blockedBefore = readPersistBlocked;
    let readPersistBlockedInRequest = 0;
    try {
      await ensureTables(client);
      closeAllDatabases();
      const lockAdmin = options.lockAdmin ?? (scope === 'admin' || Boolean(options.preAuthorize));
      const adminEntry: Entry = { key: 'admin', file: adminDatabasePath(), locked: false };
      entries.push(adminEntry);
      // Lock order is fixed: 'admin' (if taken) before any organization key, organizations sorted.
      if (lockAdmin) await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_NAMESPACE, 'admin']);
      await sync(client, [adminEntry], state);
      process.env.SOLIVY_SQLITE_BRIDGE = '1';

      // Decide which organization files this request may touch, using admin.db only.
      setBridgeScope([adminEntry.file], false);
      const { adminDb } = await import('./db');
      const admin = adminDb();
      // Publish the public login projection whenever this instance sees a newer admin snapshot, so
      // the sign-in screen never hydrates admin.db (measured 801 KB per visit). Derived data only:
      // organization id, name and code — the same list the screen already shows.
      const adminVersion = state.get('admin')?.copy?.version || '';
      if (adminVersion && adminVersion !== publishedAdminVersion) {
        try {
          if (await projectionVersion(client) !== Number(adminVersion)) await refreshLoginCompanies(client, admin, adminVersion);
          publishedAdminVersion = adminVersion;
        } catch (error) { console.error('SOLIVY login projection refresh skipped', error); }
      }
      const wanted: Array<{ id: number; mode: 'LIVE' | 'TEST' }> = [];
      if (options.preAuthorize) {
        const ctx = options.preAuthorize(req, admin);
        wanted.push({ id: ctx.companyId, mode: ctx.mode });
      } else if (scope !== 'admin') {
        const id = Number(req.headers.get('x-aksh-company-id') || 0);
        const mode = req.headers.get('x-aksh-mode') === 'TEST' ? 'TEST' as const : 'LIVE' as const;
        const username = String(req.headers.get('x-aksh-user') || '');
        const isAdmin = req.headers.get('x-aksh-role') === 'ADMIN';
        if (scope === 'all' || scope === 'all-mode') {
          const ids = (admin.prepare(`SELECT id FROM companies ${scope === 'all-mode' ? 'WHERE active=1' : ''}`).all() as any[]).map((r) => Number(r.id));
          for (const cid of ids) for (const m of (scope === 'all' ? ['LIVE', 'TEST'] as const : [mode])) wanted.push({ id: cid, mode: m });
        } else if (Number.isSafeInteger(id) && id > 0) {
          wanted.push({ id, mode });
          if (scope === 'company-both') wanted.push({ id, mode: mode === 'LIVE' ? 'TEST' : 'LIVE' });
          const granted = new Set((admin.prepare(`SELECT uc.company_id id FROM user_companies uc JOIN admin_users u ON u.id=uc.user_id JOIN companies c ON c.id=uc.company_id WHERE u.username=? AND u.active=1 AND c.active=1 AND ${mode === 'TEST' ? 'uc.can_test=1' : 'uc.can_live=1'}`).all(username) as any[]).map((r) => Number(r.id)));
          const extra: number[] = [];
          try {
            if (req.method !== 'GET' && (req.headers.get('content-type') || '').includes('json')) {
              const body = await req.clone().json();
              const dest = Number(body?.destination_company_id || body?.destinationCompanyId || 0);
              if (Number.isSafeInteger(dest) && dest > 0) extra.push(dest);
            }
          } catch { /* not JSON */ }
          if (options.extraCompanies) extra.push(...await options.extraCompanies(req, admin));
          for (const cid of extra) if (cid !== id && (granted.has(cid) || isAdmin)) wanted.push({ id: cid, mode });
          if (options.extraFiles) {
            for (const f of await options.extraFiles(req, admin)) {
              if (!Number.isSafeInteger(f.id) || f.id <= 0) continue;
              if (!granted.has(f.id) && !isAdmin) continue;
              if (!wanted.some((w) => w.id === f.id && w.mode === f.mode)) wanted.push({ id: f.id, mode: f.mode });
            }
          }
        }
      }
      // Which organization files something still pulls from (an active paired device on this hub).
      // Used after the request to keep the transport journal of unpulled databases from inflating
      // every hydration; see lib/sync-prune.ts.
      const consumers = new Map<string, boolean>();
      try {
        for (const c of wanted) {
          const row = admin.prepare("SELECT COUNT(*) n FROM sync_devices WHERE company_id=? AND mode=? AND active=1").get(c.id, c.mode) as any;
          consumers.set(keyFor(c.id, c.mode), Number(row?.n || 0) > 0);
        }
      } catch { /* sync_devices is created on first pairing */ }
      closeAllDatabases();
      for (const c of wanted) entries.push({ key: keyFor(c.id, c.mode), file: databasePath(c.mode, c.id), locked: true });
      for (const k of [...new Set(entries.filter((e) => e.locked).map((e) => e.key))].sort()) await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_NAMESPACE, k]);
      await sync(client, entries, state);

      setBridgeScope(entries.map((e) => e.file), Boolean(options.allowCreate));
      try { response = await guarded(req, ...args); }
      catch (error: any) { response = Response.json({ error: error?.message || 'Database request failed.' }, { status: error?.status || 500 }); }

      // Trim the synchronization journal of databases nothing pulls from. Only after a successful
      // mutation: a read must never turn into a write (and so into an upload).
      if (!['GET', 'HEAD'].includes(req.method.toUpperCase()) && response && response.status < 400) {
        const { db: openCompanyDb } = await import('./db');
        for (const e of entries) {
          if (e.key === 'admin' || !fs.existsSync(e.file)) continue;
          const m = e.key.match(/^company:(\d+):(LIVE|TEST)$/); if (!m) continue;
          try { pruneSyncJournal(openCompanyDb(m[2] as 'LIVE' | 'TEST', Number(m[1])), { hasConsumers: consumers.get(e.key) ?? true }); }
          catch (error) { console.error('SOLIVY journal trim skipped', e.key, error); }
        }
      }

      // ---- persist changed files in ONE transaction ----
      const created = bridgeCreatedFiles();
      closeAllDatabases();
      setBridgeScope(null);
      const writes: Array<{ e: Entry; bytes: Buffer }> = [];
      for (const e of entries) {
        if (!fs.existsSync(e.file)) continue;
        if (snapshotReplaced.has(e.key)) { snapshotReplaced.delete(e.key); continue; }
        const bytes = fs.readFileSync(e.file);
        if (state.get(e.key)?.copy?.sha === sha256(bytes)) continue;
        // A READ route may not persist. The one thing that must still go through is a schema
        // upgrade of a file this request had to open, because discarding it would lose the
        // migration; anything else is a defect, so it is counted, logged and NOT uploaded.
        if (access === 'READ') {
          const st = state.get(e.key);
          // A database that does not exist remotely must not be created by a read: the local file
          // SQLite just made is discarded instead of being published (a backup of a never-used
          // environment reports it as empty rather than bringing it into existence).
          if (!st || st.copy === null) { readSkippedNew++; continue; }
          const migrated = Boolean(st.original) || st.userVersion < SCHEMA_VERSION;
          if (!migrated) {
            readPersistBlocked++;
            lastReadViolation = `${req.method} ${new URL(req.url).pathname} tried to persist ${e.key}`;
            console.error(`SOLIVY read-only guard: ${lastReadViolation}; the change was not uploaded.`);
            continue;
          }
        }
        writes.push({ e, bytes });
      }
      for (const file of created) {
        const m = path.resolve(file).match(/companies[\\/](\d+)[\\/](live|test)\.db$/);
        if (!m || !fs.existsSync(file) || entries.some((e) => path.resolve(e.file) === path.resolve(file))) continue;
        const e: Entry = { key: keyFor(Number(m[1]), m[2] === 'live' ? 'LIVE' : 'TEST'), file, locked: true };
        state.set(e.key, { copy: null, userVersion: 0 });
        writes.push({ e, bytes: fs.readFileSync(file) });
      }
      if (writes.length) {
        await client.query('BEGIN');
        const committed: Array<[string, LocalCopy]> = [];
        try {
          for (const w of writes) {
            const st = state.get(w.e.key);
            if (st?.original) await backupSnapshot(client, w.e.key, st.original, `pre-migration v${st.userVersion}->v${SCHEMA_VERSION}`);
            const next = await writeSnapshot(client, w.e.key, w.bytes, st?.copy ?? null);
            if (!next) throw new BridgeConflict(`Another request changed ${w.e.key === 'admin' ? 'administration data' : 'this organization'} at the same time. Nothing from this request was saved; please retry.`, w.e.key === 'admin' ? 'admin' : 'company');
            committed.push([w.e.key, next]);
            if (w.e.key === 'admin') {
              // Keep the login screen's organization list in step with the snapshot just written,
              // so the sign-in page never has to hydrate admin.db (lib/public-projection.ts).
              await ensureProjectionTable(client);
              const ro = new Database(w.e.file, { readonly: true });
              try { await refreshLoginCompanies(client, ro, next.version); publishedAdminVersion = next.version; } finally { ro.close(); }
            }
          }
          await client.query('COMMIT');
          for (const [k, v] of committed) localCache.set(k, v);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }
      if (response) {
        const body = Buffer.from(await response.clone().arrayBuffer());
        responseBytes = body.length;
      }
      readPersistBlockedInRequest = readPersistBlocked - blockedBefore;
      return response!;
    } catch (error: any) {
      closeAllDatabases();
      setBridgeScope(null);
      if (error instanceof BridgeConflict) return Response.json({ error: error.message, code: error.code }, { status: 409, headers: { 'x-solivy-conflict': error.scope } });
      if (response && response.status < 400) {
        console.error('SOLIVY PostgreSQL snapshot persistence failed:', error);
        return Response.json({ error: 'The change could not be saved to PostgreSQL and was NOT recorded. It is safe to retry.', code: 'DATABASE_PERSIST_FAILED' }, { status: 503 });
      }
      return Response.json({ error: error?.message || 'Database request failed.' }, { status: error?.status || 500 });
    } finally {
      delete process.env.SOLIVY_SQLITE_BRIDGE;
      try { await client.query('SELECT pg_advisory_unlock_all()'); } catch {}
      try {
        recordRequest({ url: req.url, method: req.method, status: response?.status ?? 500, companyId: Number(req.headers.get('x-aksh-company-id') || 0), mode: req.headers.get('x-aksh-mode') === 'TEST' ? 'TEST' : 'LIVE', requestBytes: Number(req.headers.get('content-length') || 0), responseBytes: responseBytes, startedAt, cached: response?.status === 304, access, blocked: readPersistBlockedInRequest });
        if (Date.now() - lastMetricsFlush > 30000) { lastMetricsFlush = Date.now(); await flushMetrics(client); }
      } catch (error) { if (process.env.SOLIVY_BRIDGE_DEBUG) console.error('transfer metrics skipped', error); }
      client.release();
    }
  }
}
