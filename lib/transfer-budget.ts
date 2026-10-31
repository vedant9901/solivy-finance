import type { PoolClient } from 'pg';
import { METRICS_TABLE, ensureMetricsTable } from './transfer-metrics';

/**
 * Monthly transfer budget monitoring and spike detection (v2.7.2).
 *
 * The budget is the allowance you have with your database provider, set in GB through
 * SOLIVY_TRANSFER_BUDGET_GB (default 25). Month-to-date usage is summed from the application's own
 * per-request counters, so it is the transfer THIS APPLICATION measured: compressed snapshot
 * payloads, without TLS or protocol overhead. It is a lower bound on what the provider bills and
 * is never presented as the provider's figure.
 *
 * Alerts fire once per month per threshold (50%, 75%, 90%, 100%): a crossing is recorded in
 * solivy_transfer_alerts, so a restart or another instance does not repeat it.
 *
 * Spike detection compares each endpoint's bytes today against its own median over the previous
 * days of the window, and names the endpoints that are far above their own normal — which is what
 * identifies the responsible endpoint rather than just the biggest one.
 */
export const ALERTS_TABLE = 'solivy_transfer_alerts';
export const THRESHOLDS = [50, 75, 90, 100] as const;
export const SPIKE_FACTOR = 3;
export const SPIKE_MIN_BYTES = 5 * 1024 * 1024;

export function budgetBytes() {
  const gb = Number(process.env.SOLIVY_TRANSFER_BUDGET_GB || 25);
  return (Number.isFinite(gb) && gb > 0 ? gb : 25) * 1024 * 1024 * 1024;
}

export async function ensureAlertsTable(client: PoolClient) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${ALERTS_TABLE} (month TEXT NOT NULL, threshold INTEGER NOT NULL, used_bytes BIGINT NOT NULL, budget_bytes BIGINT NOT NULL, raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (month, threshold))`);
}

export type BudgetState = {
  month: string; budget_bytes: number; used_bytes: number; percent: number;
  thresholds: number[]; reached: number[]; newly_reached: number[];
  projected_month_end_bytes: number; projected_percent: number; days_elapsed: number; days_in_month: number;
  status: 'ok' | 'warning' | 'critical' | 'over';
  note: string;
};

/** Month-to-date usage, alert state, and any threshold crossed for the first time by this call. */
export async function budgetState(client: PoolClient, opts: { raise?: boolean } = {}): Promise<BudgetState> {
  await ensureMetricsTable(client);
  await ensureAlertsTable(client);
  const month = new Date().toISOString().slice(0, 7);
  const r = await client.query(
    `SELECT COALESCE(SUM(pg_down_bytes + pg_up_bytes), 0)::text AS used FROM ${METRICS_TABLE} WHERE to_char(day, 'YYYY-MM') = $1`, [month]);
  const used = Number(r.rows[0].used || 0);
  const budget = budgetBytes();
  const percent = budget > 0 ? (used / budget) * 100 : 0;
  const now = new Date();
  // The month is a UTC month (`month` above comes from toISOString), so its length must be
  // computed in UTC too. Building a local date and reading getUTCDate() returned the wrong length
  // in any zone ahead of UTC — October read as 30 days in Asia/Kolkata — which made the month-end
  // projection understate measured usage on the last day of a month.
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsed = now.getUTCDate();
  const projected = Math.round(used / Math.max(1, daysElapsed) * daysInMonth);

  const already = new Set<number>((await client.query(`SELECT threshold FROM ${ALERTS_TABLE} WHERE month=$1`, [month])).rows.map((x: any) => Number(x.threshold)));
  const reached = THRESHOLDS.filter((t) => percent >= t);
  const newly = reached.filter((t) => !already.has(t));
  if (opts.raise !== false && newly.length) {
    await client.query(
      `INSERT INTO ${ALERTS_TABLE}(month, threshold, used_bytes, budget_bytes) SELECT $1, t, $2, $3 FROM unnest($4::int[]) AS t
       ON CONFLICT (month, threshold) DO NOTHING`, [month, used, budget, newly]);
    for (const t of newly) console.warn(`SOLIVY transfer budget: ${t}% of the ${(budget / 1024 / 1024 / 1024).toFixed(0)} GB monthly allowance measured in ${month} (${(used / 1024 / 1024).toFixed(0)} MB).`);
  }
  const status = percent >= 100 ? 'over' : percent >= 90 ? 'critical' : percent >= 50 ? 'warning' : 'ok';
  return {
    month, budget_bytes: budget, used_bytes: used, percent: Number(percent.toFixed(2)),
    thresholds: [...THRESHOLDS], reached: [...reached], newly_reached: newly,
    projected_month_end_bytes: projected, projected_percent: budget > 0 ? Number(((projected / budget) * 100).toFixed(2)) : 0,
    days_elapsed: daysElapsed, days_in_month: daysInMonth, status,
    note: 'Application-measured transfer against SOLIVY_TRANSFER_BUDGET_GB. Excludes TLS and protocol overhead, so it is a lower bound; your provider dashboard remains the billing figure.',
  };
}

export type Spike = { endpoint: string; method: string; access: string; today_bytes: number; median_bytes: number; factor: number; requests: number; db_reads: number; db_writes: number; blocked: number };

/** Endpoints whose transfer today is far above their own recent median. */
export async function spikes(client: PoolClient, days = 14): Promise<{ spikes: Spike[]; worst: Spike | null; day: string; baseline_days: number; note: string }> {
  await ensureMetricsTable(client);
  const r = await client.query(
    `WITH daily AS (
       SELECT endpoint, method, max(access) AS access, day,
              SUM(pg_down_bytes + pg_up_bytes)::bigint AS bytes, SUM(requests)::bigint AS requests,
              SUM(db_reads)::bigint AS db_reads, SUM(db_writes)::bigint AS db_writes, SUM(blocked)::bigint AS blocked
       FROM ${METRICS_TABLE} WHERE day >= CURRENT_DATE - $1::int GROUP BY endpoint, method, day)
     SELECT t.endpoint, t.method, t.access, t.bytes::text AS today_bytes, t.requests::text AS requests,
            t.db_reads::text AS db_reads, t.db_writes::text AS db_writes, t.blocked::text AS blocked,
            COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY h.bytes), 0)::bigint::text AS median_bytes
     FROM daily t LEFT JOIN daily h ON h.endpoint = t.endpoint AND h.method = t.method AND h.day < CURRENT_DATE
     WHERE t.day = CURRENT_DATE
     GROUP BY t.endpoint, t.method, t.access, t.bytes, t.requests, t.db_reads, t.db_writes, t.blocked
     ORDER BY t.bytes DESC`, [days]);
  const out: Spike[] = r.rows.map((x: any) => {
    const today = Number(x.today_bytes || 0); const median = Number(x.median_bytes || 0);
    return { endpoint: x.endpoint, method: x.method, access: x.access, today_bytes: today, median_bytes: median, factor: median > 0 ? Number((today / median).toFixed(2)) : (today > 0 ? Infinity : 0), requests: Number(x.requests || 0), db_reads: Number(x.db_reads || 0), db_writes: Number(x.db_writes || 0), blocked: Number(x.blocked || 0) };
  }).filter((s: Spike) => s.today_bytes >= SPIKE_MIN_BYTES && (s.median_bytes === 0 || s.factor >= SPIKE_FACTOR));
  out.sort((a, b) => b.today_bytes - a.today_bytes);
  return { spikes: out, worst: out[0] || null, day: new Date().toISOString().slice(0, 10), baseline_days: days, note: `An endpoint is flagged when it moved at least ${(SPIKE_MIN_BYTES / 1024 / 1024).toFixed(0)} MB today and at least ${SPIKE_FACTOR}× its own median for the previous days in the window (or had no history).` };
}
