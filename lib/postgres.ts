import { Pool } from 'pg';

// Neon PostgreSQL is used only when DATABASE_URL is configured.
// Local Windows installs continue to use better-sqlite3 through lib/db.ts.
const globalForPg = globalThis as unknown as { solivyPgPool?: Pool };

export function postgresPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not configured for PostgreSQL mode.');
  if (!globalForPg.solivyPgPool) {
    globalForPg.solivyPgPool = new Pool({
      connectionString,
      // Neon requires TLS with certificate verification. SOLIVY_PG_SSL=disable is honoured ONLY
      // for a loopback host (local PostgreSQL used by the automated online-mode tests).
      ssl: sslFor(connectionString),
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForPg.solivyPgPool;
}

export function usesPostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function sslFor(connectionString: string) {
  if (process.env.SOLIVY_PG_SSL === 'disable') {
    try { const host = new URL(connectionString).hostname; if (['127.0.0.1', 'localhost', '::1'].includes(host)) return false as const; } catch {}
    throw new Error('SOLIVY_PG_SSL=disable is only permitted for a local PostgreSQL host.');
  }
  return { rejectUnauthorized: true };
}
