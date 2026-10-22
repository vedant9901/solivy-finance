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
      // Neon requires TLS. Keep certificate verification enabled.
      ssl: { rejectUnauthorized: true },
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
