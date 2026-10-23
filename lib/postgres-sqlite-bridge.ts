import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PoolClient } from 'pg';
import { postgresPool, usesPostgres } from './postgres';
import { appDataDirectory, closeAllDatabases, databasePath, adminDatabasePath } from './db';

/**
 * Compatibility bridge for v2.5.30.
 * Existing API handlers use synchronous better-sqlite3 calls. On Vercel, this
 * bridge loads each SQLite working database from durable PostgreSQL BYTEA
 * storage under a PostgreSQL advisory lock, runs the unchanged handler, then
 * writes the closed database file back before returning. Local Windows installs
 * bypass this bridge and continue using their normal live.db/test.db files.
 *
 * The lock intentionally serializes writes across serverless instances so two
 * concurrent requests cannot overwrite each other's snapshot. For very large
 * datasets this compatibility strategy is slower than a native async PG schema;
 * it is designed to preserve existing behavior while the routes are migrated.
 */
const LOCK_ID = 530202530;
const SNAPSHOT_TABLE = 'solivy_sqlite_snapshots';

type RouteHandler = (req: Request, ...args: any[]) => Promise<Response> | Response;

async function logicalFiles(req: Request) {
  const headers = req.headers;
  const companyId = Math.max(1, Number(headers.get('x-aksh-company-id') || new URL(req.url).searchParams.get('company_id') || 1) || 1);
  const mode = headers.get('x-aksh-mode') === 'TEST' ? 'TEST' : 'LIVE';
  const ids = new Set<number>([1, companyId]);
  // Cross-company accounting routes may write into a second company's LIVE/TEST snapshot.
  // Read a clone so the original request body remains available to the route handler.
  try { const body = await req.clone().json(); const destination = Number(body?.destination_company_id || body?.destinationCompanyId || 0); if (Number.isSafeInteger(destination) && destination > 0) ids.add(destination); } catch { /* GET, non-JSON and bodyless requests have no destination */ }
  const files: Array<{ key: string; file: string }> = [{ key: 'admin', file: adminDatabasePath() }];
  for (const id of ids) {
    for (const m of ['LIVE', 'TEST'] as const) files.push({ key: `company:${id}:${m}`, file: databasePath(m, id) });
  }
  // Keep appDataDirectory referenced to ensure the same configured data root is used.
  void appDataDirectory();
  return files;
}

async function ensureSnapshotTable(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
    db_key TEXT PRIMARY KEY,
    db_file BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function hydrate(client: PoolClient, key: string, file: string) {
  const result = await client.query(`SELECT db_file FROM ${SNAPSHOT_TABLE} WHERE db_key = $1`, [key]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Remove stale sidecar files before replacing the closed working copy.
  for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} }
  if (result.rows.length && result.rows[0].db_file) fs.writeFileSync(file, result.rows[0].db_file);
  else { try { fs.unlinkSync(file); } catch {} }
}

async function persist(client: PoolClient, key: string, file: string) {
  if (!fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  await client.query(
    `INSERT INTO ${SNAPSHOT_TABLE}(db_key, db_file, updated_at) VALUES($1, $2, NOW())
     ON CONFLICT(db_key) DO UPDATE SET db_file = EXCLUDED.db_file, updated_at = NOW()`,
    [key, bytes],
  );
}

export function withPostgresSQLiteBridge(handler: RouteHandler): (req: Request, ...args: any[]) => Promise<Response> {
  const wrapped = (async (req: Request, ...args: any[]) => {
    const isVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV) || Boolean(process.env.VERCEL_REGION) || process.cwd().replace(/\\/g, '/').startsWith('/var/task');
    if (!isVercel) return handler(req, ...args);
    if (!usesPostgres()) {
      return Response.json({ error: 'DATABASE_URL is required on Vercel. Configure a persistent PostgreSQL/Neon database before using SOLIVY Finance online.' }, { status: 503 });
    }

    const client = await postgresPool().connect();
    let files = await logicalFiles(req);
    let response: Response | undefined;
    let requestError: any;
    let persistenceError: any;
    let lockAcquired = false;
    try {
      // Session-level lock is held on this same PostgreSQL connection until the
      // request's snapshots have been persisted.
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
      lockAcquired = true;
      await ensureSnapshotTable(client);
      closeAllDatabases();
      for (const entry of files) await hydrate(client, entry.key, entry.file);
      // Backup/admin operations can touch every company. Discover known company
      // IDs from the hydrated admin snapshot and load both environments before
      // the handler runs, so those routes never fall back to empty local files.
      const adminFile = adminDatabasePath();
      if (fs.existsSync(adminFile)) {
        let knownIds: number[] = [];
        const adminSnapshot = new Database(adminFile);
        try {
          const table = adminSnapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'").get() as any;
          if (table) knownIds = (adminSnapshot.prepare('SELECT id FROM companies').all() as any[]).map((x) => Number(x.id)).filter((x) => Number.isInteger(x) && x > 0);
        } catch { /* first-run admin database may not have its schema yet */ }
        finally { adminSnapshot.close(); }
        const keys = new Set(files.map((x) => x.key));
        for (const id of knownIds) {
          for (const mode of ['LIVE', 'TEST'] as const) {
            const key = `company:${id}:${mode}`;
            if (!keys.has(key)) {
              const entry = { key, file: databasePath(mode, id) };
              await hydrate(client, entry.key, entry.file);
              files.push(entry);
              keys.add(key);
            }
          }
        }
      }
      process.env.SOLIVY_SQLITE_BRIDGE = '1';
      try {
        response = await handler(req, ...args);
      } catch (error: any) {
        requestError = error;
      }
    } catch (error: any) {
      requestError = error;
    } finally {
      try {
        closeAllDatabases();
        for (const entry of files) await persist(client, entry.key, entry.file);
      } catch (error: any) {
        persistenceError = error;
        console.error('SOLIVY PostgreSQL snapshot persistence failed:', error);
      }
      delete process.env.SOLIVY_SQLITE_BRIDGE;
      if (lockAcquired) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch {}
      }
      client.release();
    }
    if (persistenceError) return Response.json({ error: 'The request could not be confirmed as saved to PostgreSQL. Please retry only after checking whether the operation was recorded.', code: 'DATABASE_PERSIST_FAILED' }, { status: 503 });
    if (requestError) return Response.json({ error: requestError?.message || 'Database request failed.' }, { status: 500 });
    return response || Response.json({ error: 'The API returned no response.' }, { status: 500 });
  }) as (req: Request, ...args: any[]) => Promise<Response>;
  return wrapped;
}
