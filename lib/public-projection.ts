import type { PoolClient } from 'pg';
import type Database from 'better-sqlite3';

/**
 * Tiny derived projections in PostgreSQL for data the UNAUTHENTICATED pages need.
 *
 * The sign-in screen only needs the names of the active organizations, but reading them from
 * admin.db meant hydrating that snapshot — measured 801 KB of Neon transfer for every visit to the
 * login page, by anyone, signed in or not. The bridge refreshes this projection in the same
 * transaction as every admin.db write, so the row is never newer or older than the snapshot it
 * came from; a request that finds no row falls back to hydrating admin.db once.
 *
 * It holds only what the login screen already displays (organization id, name, code). No
 * credentials, no user data, no financial data.
 */
export const PROJECTION_TABLE = 'solivy_public_projections';

export async function ensureProjectionTable(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${PROJECTION_TABLE} (key TEXT PRIMARY KEY, payload TEXT NOT NULL, source_version BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

/** Rebuild the login-screen organization list from the admin.db handle. Call inside the write transaction. */
export async function refreshLoginCompanies(client: PoolClient, admin: Database.Database, version: string) {
  const rows = admin.prepare('SELECT id, name, code FROM companies WHERE active = 1 ORDER BY name').all();
  await client.query(
    `INSERT INTO ${PROJECTION_TABLE}(key, payload, source_version, updated_at) VALUES('login_companies', $1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET payload=EXCLUDED.payload, source_version=EXCLUDED.source_version, updated_at=NOW()`,
    [JSON.stringify(rows), Number(version) || 0]);
}

/** Current source version of a projection row (0 when missing). */
export async function projectionVersion(client: PoolClient, key = 'login_companies'): Promise<number> {
  await ensureProjectionTable(client);
  const r = await client.query(`SELECT source_version::text AS v FROM ${PROJECTION_TABLE} WHERE key=$1`, [key]);
  return r.rowCount ? Number(r.rows[0].v) || 0 : 0;
}

export async function readLoginCompanies(client: PoolClient): Promise<Array<{ id: number; name: string; code: string }> | null> {
  await ensureProjectionTable(client);
  const r = await client.query(`SELECT payload FROM ${PROJECTION_TABLE} WHERE key='login_companies'`);
  if (!r.rowCount) return null;
  try { const v = JSON.parse(String(r.rows[0].payload)); return Array.isArray(v) ? v : null; } catch { return null; }
}
