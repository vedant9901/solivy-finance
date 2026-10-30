import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/db';
import { postgresPool, usesPostgres } from '../../../../lib/postgres';
import { METRICS_TABLE, ensureMetricsTable, flushMetrics, pendingMetrics } from '../../../../lib/transfer-metrics';
import { SNAPSHOT_TABLE, CHUNK_TABLE } from '../../../../lib/snapshot-store';
import { budgetState, spikes, budgetBytes } from '../../../../lib/transfer-budget';
import { bridgeGuardStats } from '../../../../lib/postgres-sqlite-bridge';
import { API_ACCESS } from '../../../../lib/api-access';

/**
 * GET /api/admin/transfer-metrics?days=30 — administrator-only API and database transfer report.
 *
 * Figures are APPLICATION-MEASURED (compressed snapshot payloads this application moved, excluding
 * TLS and protocol overhead), never the provider's billing meter; the response says so and the
 * screen repeats it. No query values, bodies, user names or financial values are recorded.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function denyUnlessAdmin(req: Request) {
  if (req.headers.get('x-aksh-role') !== 'ADMIN') return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });
  return null;
}

async function handler(req: Request) {
  const denied = denyUnlessAdmin(req); if (denied) return denied;
  const days = Math.min(400, Math.max(1, Number(new URL(req.url).searchParams.get('days') || 30)));
  const names = new Map<number, string>();
  try { for (const c of adminDb().prepare('SELECT id, name FROM companies').all() as any[]) names.set(Number(c.id), String(c.name)); } catch {}
  const note = 'Application-measured transfer: the compressed snapshot bytes this application read from and wrote to PostgreSQL, plus API request and response bytes. Excludes TLS, PostgreSQL protocol overhead and connection setup, so it is a lower bound. Your provider dashboard (for example Neon "Data transfer") remains the billing figure.';

  if (!usesPostgres()) {
    const rows = pendingMetrics();
    return NextResponse.json({ ok: true, storage: 'memory (offline mode — this process only)', note, days, rows, totals: totalsOf(rows), daily: [], endpoints: [], snapshots: [], budget: { budget_bytes: budgetBytes(), used_bytes: 0, percent: 0, status: 'ok', note: 'Offline installs transfer nothing to a database provider.' }, spikes: { spikes: [], worst: null }, guards: { ...bridgeGuardStats(), declared_routes: Object.keys(API_ACCESS).length } });
  }
  const client = await postgresPool().connect();
  try {
    await ensureMetricsTable(client);
    await flushMetrics(client);
    const since = `${days} days`;
    const rows = (await client.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, endpoint, method, company_id, mode, access, db_reads::bigint, db_writes::bigint, blocked::bigint, requests::bigint, cached::bigint, errors::bigint, request_bytes::bigint, response_bytes::bigint, pg_down_bytes::bigint, pg_up_bytes::bigint, chunks_down::bigint, chunks_up::bigint, full_downloads::bigint, base_downloads::bigint, total_ms::bigint FROM ${METRICS_TABLE} WHERE day >= CURRENT_DATE - $1::interval ORDER BY day DESC, pg_down_bytes + pg_up_bytes DESC`, [since])).rows.map(numeric);
    const daily = (await client.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, SUM(requests)::bigint requests, SUM(cached)::bigint cached, SUM(response_bytes)::bigint response_bytes, SUM(pg_down_bytes)::bigint pg_down_bytes, SUM(pg_up_bytes)::bigint pg_up_bytes FROM ${METRICS_TABLE} WHERE day >= CURRENT_DATE - $1::interval GROUP BY day ORDER BY day DESC`, [since])).rows.map(numeric);
    const endpoints = (await client.query(`SELECT endpoint, method, max(access) AS access, SUM(requests)::bigint requests, SUM(cached)::bigint cached, SUM(errors)::bigint errors, SUM(db_reads)::bigint db_reads, SUM(db_writes)::bigint db_writes, SUM(blocked)::bigint blocked, SUM(response_bytes)::bigint response_bytes, SUM(pg_down_bytes)::bigint pg_down_bytes, SUM(pg_up_bytes)::bigint pg_up_bytes, SUM(total_ms)::bigint total_ms FROM ${METRICS_TABLE} WHERE day >= CURRENT_DATE - $1::interval GROUP BY endpoint, method ORDER BY SUM(pg_down_bytes) + SUM(pg_up_bytes) DESC LIMIT 40`, [since])).rows.map(numeric);
    const months = (await client.query(`SELECT to_char(date_trunc('month', day),'YYYY-MM') AS month, SUM(requests)::bigint requests, SUM(pg_down_bytes)::bigint pg_down_bytes, SUM(pg_up_bytes)::bigint pg_up_bytes, SUM(response_bytes)::bigint response_bytes FROM ${METRICS_TABLE} GROUP BY 1 ORDER BY 1 DESC LIMIT 13`)).rows.map(numeric);
    const budget = await budgetState(client);
    const spike = await spikes(client, Math.max(7, Math.min(days, 60)));
    const access = (await client.query(`SELECT access, SUM(requests)::bigint requests, SUM(db_reads)::bigint db_reads, SUM(db_writes)::bigint db_writes, SUM(blocked)::bigint blocked, SUM(pg_down_bytes)::bigint pg_down_bytes, SUM(pg_up_bytes)::bigint pg_up_bytes FROM ${METRICS_TABLE} WHERE day >= CURRENT_DATE - $1::interval GROUP BY access ORDER BY access`, [since])).rows.map(numeric);
    const snapshots = (await client.query(`SELECT s.db_key, s.version::text version, s.size_bytes::bigint AS size_bytes, s.chunk_size, octet_length(s.db_file) base_bytes, (SELECT COUNT(*) FROM ${CHUNK_TABLE} c WHERE c.db_key=s.db_key)::bigint chunks, (SELECT COALESCE(SUM(octet_length(c.data)),0) FROM ${CHUNK_TABLE} c WHERE c.db_key=s.db_key)::bigint stored_bytes, to_char(s.updated_at,'YYYY-MM-DD HH24:MI') updated_at FROM ${SNAPSHOT_TABLE} s ORDER BY s.db_key`)).rows.map(numeric);
    return NextResponse.json({
      ok: true, storage: 'postgres', note, days,
      organizations: [...names].map(([id, name]) => ({ id, name })),
      totals: totalsOf(rows), daily, endpoints, months, snapshots, rows: rows.slice(0, 500),
      budget, spikes: spike, access,
      guards: { ...bridgeGuardStats(), declared_routes: Object.keys(API_ACCESS).length },
    });
  } finally { client.release(); }
}

function numeric(row: any) { const out: any = {}; for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v; return out; }
function totalsOf(rows: any[]) {
  const t = { requests: 0, cached: 0, errors: 0, request_bytes: 0, response_bytes: 0, pg_down_bytes: 0, pg_up_bytes: 0, chunks_down: 0, chunks_up: 0, full_downloads: 0, base_downloads: 0 };
  for (const r of rows) for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += Number((r as any)[k] || 0);
  return { ...t, cache_hit_rate: t.requests ? Number(((t.cached / t.requests) * 100).toFixed(1)) : 0, pg_total_bytes: t.pg_down_bytes + t.pg_up_bytes };
}

const __wrapped_GET = withPostgresSQLiteBridge(handler, { scope: 'admin' });
export async function GET(req: Request) { return __wrapped_GET(req); }
