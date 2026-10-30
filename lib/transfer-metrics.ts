import { transferStats, resetTransferStats } from './snapshot-store';
import type { PoolClient } from 'pg';

/**
 * Transfer diagnostics (v2.7.1).
 *
 * Records, per API request: the endpoint, the request and response bytes the application handled,
 * the snapshot bytes this instance pulled from and pushed to PostgreSQL, whether the request was
 * answered from a conditional cache (304), and the organization and environment it belonged to.
 * Rows are aggregated per day, per endpoint, per organization and environment in PostgreSQL, so
 * several serverless instances report into one place.
 *
 * These are APPLICATION-MEASURED figures: the compressed snapshot payloads this process moved,
 * excluding TLS, PostgreSQL protocol overhead, connection setup and anything another client does.
 * They are a close lower bound for the provider's "data transfer" meter, never a substitute for
 * it: the provider's own dashboard remains the billing figure, and the API labels them as such.
 *
 * No URL query values, request bodies, response bodies, user names or financial values are stored
 * — only the route path, counters, and the organization/environment the request already carried.
 */
export const METRICS_TABLE = 'solivy_transfer_metrics';

export type RequestMetric = {
  day: string; endpoint: string; method: string; company_id: number; mode: string; access: string;
  requests: number; cached: number; errors: number; db_reads: number; db_writes: number; blocked: number;
  request_bytes: number; response_bytes: number;
  pg_down_bytes: number; pg_up_bytes: number; chunks_down: number; chunks_up: number;
  full_downloads: number; base_downloads: number; ms: number;
};

const pending = new Map<string, RequestMetric>();
/** Endpoints are recorded as the route path only; never the query string. */
export function routeOf(url: string) { try { return new URL(url).pathname.slice(0, 120); } catch { return '/'; } }

export function beginRequest() { resetTransferStats(); return Date.now(); }

export function recordRequest(info: { url: string; method: string; status: number; companyId: number; mode: string; requestBytes: number; responseBytes: number; startedAt: number; cached: boolean; access?: string; blocked?: number }) {
  const day = new Date().toISOString().slice(0, 10);
  const endpoint = routeOf(info.url);
  const access = info.access || 'READ';
  const key = `${day}|${endpoint}|${info.method}|${info.companyId}|${info.mode}|${access}`;
  const row = pending.get(key) || { day, endpoint, method: info.method, company_id: info.companyId, mode: info.mode, access, requests: 0, cached: 0, errors: 0, db_reads: 0, db_writes: 0, blocked: 0, request_bytes: 0, response_bytes: 0, pg_down_bytes: 0, pg_up_bytes: 0, chunks_down: 0, chunks_up: 0, full_downloads: 0, base_downloads: 0, ms: 0 };
  row.requests += 1;
  // A "database read" is a request that pulled snapshot bytes; a "database write" one that pushed.
  if (transferStats.bytesDown > 0) row.db_reads += 1;
  if (transferStats.bytesUp > 0) row.db_writes += 1;
  row.blocked += Number(info.blocked || 0);
  if (info.cached) row.cached += 1;
  if (info.status >= 400) row.errors += 1;
  row.request_bytes += info.requestBytes;
  row.response_bytes += info.responseBytes;
  row.pg_down_bytes += transferStats.bytesDown;
  row.pg_up_bytes += transferStats.bytesUp;
  row.chunks_down += transferStats.chunksDown;
  row.chunks_up += transferStats.chunksUp;
  row.full_downloads += transferStats.fullDownloads;
  row.base_downloads += transferStats.baseDownloads;
  row.ms += Math.max(0, Date.now() - info.startedAt);
  pending.set(key, row);
}

export async function ensureMetricsTable(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (
    day DATE NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, company_id INTEGER NOT NULL, mode TEXT NOT NULL,
    requests BIGINT NOT NULL DEFAULT 0, cached BIGINT NOT NULL DEFAULT 0, errors BIGINT NOT NULL DEFAULT 0,
    request_bytes BIGINT NOT NULL DEFAULT 0, response_bytes BIGINT NOT NULL DEFAULT 0,
    pg_down_bytes BIGINT NOT NULL DEFAULT 0, pg_up_bytes BIGINT NOT NULL DEFAULT 0,
    chunks_down BIGINT NOT NULL DEFAULT 0, chunks_up BIGINT NOT NULL DEFAULT 0,
    full_downloads BIGINT NOT NULL DEFAULT 0, base_downloads BIGINT NOT NULL DEFAULT 0,
    total_ms BIGINT NOT NULL DEFAULT 0,
    access TEXT NOT NULL DEFAULT 'READ', db_reads BIGINT NOT NULL DEFAULT 0, db_writes BIGINT NOT NULL DEFAULT 0, blocked BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, endpoint, method, company_id, mode))`);
  await client.query(`ALTER TABLE ${METRICS_TABLE} ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'READ', ADD COLUMN IF NOT EXISTS db_reads BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS db_writes BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS blocked BIGINT NOT NULL DEFAULT 0`);
}

/** Flush the counters accumulated in this instance. Cheap: one statement for all pending rows. */
export async function flushMetrics(client: PoolClient) {
  if (!pending.size) return 0;
  const rows = [...pending.values()]; pending.clear();
  await ensureMetricsTable(client);
  await client.query(
    `INSERT INTO ${METRICS_TABLE} (day, endpoint, method, company_id, mode, requests, cached, errors, request_bytes, response_bytes, pg_down_bytes, pg_up_bytes, chunks_down, chunks_up, full_downloads, base_downloads, total_ms, access, db_reads, db_writes, blocked)
     SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[], $11::bigint[], $12::bigint[], $13::bigint[], $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[], $18::text[], $19::bigint[], $20::bigint[], $21::bigint[])
     ON CONFLICT (day, endpoint, method, company_id, mode) DO UPDATE SET
       access=EXCLUDED.access, db_reads=${METRICS_TABLE}.db_reads+EXCLUDED.db_reads, db_writes=${METRICS_TABLE}.db_writes+EXCLUDED.db_writes, blocked=${METRICS_TABLE}.blocked+EXCLUDED.blocked,
       requests=${METRICS_TABLE}.requests+EXCLUDED.requests, cached=${METRICS_TABLE}.cached+EXCLUDED.cached, errors=${METRICS_TABLE}.errors+EXCLUDED.errors,
       request_bytes=${METRICS_TABLE}.request_bytes+EXCLUDED.request_bytes, response_bytes=${METRICS_TABLE}.response_bytes+EXCLUDED.response_bytes,
       pg_down_bytes=${METRICS_TABLE}.pg_down_bytes+EXCLUDED.pg_down_bytes, pg_up_bytes=${METRICS_TABLE}.pg_up_bytes+EXCLUDED.pg_up_bytes,
       chunks_down=${METRICS_TABLE}.chunks_down+EXCLUDED.chunks_down, chunks_up=${METRICS_TABLE}.chunks_up+EXCLUDED.chunks_up,
       full_downloads=${METRICS_TABLE}.full_downloads+EXCLUDED.full_downloads, base_downloads=${METRICS_TABLE}.base_downloads+EXCLUDED.base_downloads,
       total_ms=${METRICS_TABLE}.total_ms+EXCLUDED.total_ms`,
    [rows.map((r) => r.day), rows.map((r) => r.endpoint), rows.map((r) => r.method), rows.map((r) => r.company_id), rows.map((r) => r.mode),
     rows.map((r) => r.requests), rows.map((r) => r.cached), rows.map((r) => r.errors), rows.map((r) => r.request_bytes), rows.map((r) => r.response_bytes),
     rows.map((r) => r.pg_down_bytes), rows.map((r) => r.pg_up_bytes), rows.map((r) => r.chunks_down), rows.map((r) => r.chunks_up),
     rows.map((r) => r.full_downloads), rows.map((r) => r.base_downloads), rows.map((r) => r.ms),
     rows.map((r) => r.access), rows.map((r) => r.db_reads), rows.map((r) => r.db_writes), rows.map((r) => r.blocked)]);
  return rows.length;
}

/** Offline mode keeps the same counters in memory so the diagnostics screen works there too. */
export function pendingMetrics() { return [...pending.values()]; }
