'use client';
import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../lib/client-http';

/**
 * Administrator API and database transfer diagnostics (v2.7.1).
 *
 * Shows what the application itself measured: API requests per endpoint, conditional-response
 * (304) hit rate, request/response bytes, and the compressed snapshot bytes read from and written
 * to PostgreSQL, with daily and monthly totals and the stored size of each snapshot.
 *
 * The figures are a lower bound on provider-billed transfer (no TLS or protocol overhead), and the
 * panel says so: the provider's own dashboard stays the billing number.
 */
const KB = (n: number) => { const v = Number(n || 0); if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`; if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`; if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`; return `${v} B`; };
const N = (n: number) => new Intl.NumberFormat('en-IN').format(Number(n || 0));

export default function TransferDiagnostics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (d: number) => {
    setBusy(true); setError('');
    try { setData(await getJson(`/api/admin/transfer-metrics?days=${d}`, { group: 'metrics' })); }
    catch (e: any) { setError(e?.message || 'Could not load transfer diagnostics.'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(days); }, [days, load]);

  const t = data?.totals || {};
  const months: any[] = data?.months || [];
  const thisMonth = months[0];
  return (
    <section className="card grid gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">API &amp; database transfer</h2>
          <p className="muted text-xs">Application-measured. Not a provider bill.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold">Window
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-2">
              <option value={1}>Today</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
            </select>
          </label>
          <button type="button" className="btn border border-slate-200 bg-white text-xs" onClick={() => load(days)} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
        </div>
      </header>

      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      {data && (<>
        <p className="muted rounded-lg border border-dashed border-slate-200 p-3 text-xs">{data.note}{data.storage !== 'postgres' ? ' Offline mode: counters are kept in this process only.' : ''}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="API requests" value={N(t.requests)} note={`${t.cache_hit_rate || 0}% answered 304 (not re-sent)`} />
          <Tile label="Database download" value={KB(t.pg_down_bytes)} note={`${N(t.chunks_down)} chunks, ${N(t.full_downloads)} full reloads`} />
          <Tile label="Database upload" value={KB(t.pg_up_bytes)} note={`${N(t.chunks_up)} chunks written`} />
          <Tile label="API responses" value={KB(t.response_bytes)} note={`${N(t.errors)} failed requests`} />
        </div>

        {data.budget && (
          <div className={`rounded-lg p-3 text-sm ${data.budget.status === 'over' || data.budget.status === 'critical' ? 'bg-rose-50 text-rose-800' : data.budget.status === 'warning' ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-900'}`} role={data.budget.status === 'ok' ? undefined : 'alert'}>
            <strong>Monthly budget {data.budget.month || ''}: {data.budget.percent}% used</strong> — {KB(data.budget.used_bytes)} of {KB(data.budget.budget_bytes)}
            {data.budget.projected_percent ? <> · at this rate, {data.budget.projected_percent}% by month end ({KB(data.budget.projected_month_end_bytes)})</> : null}
            {data.budget.reached?.length ? <> · thresholds reached: {data.budget.reached.join('%, ')}%</> : null}
            <div className="muted mt-1 text-xs">{data.budget.note} Set the allowance with SOLIVY_TRANSFER_BUDGET_GB.</div>
          </div>
        )}

        {data.spikes?.worst && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert">
            <strong>Transfer spike today:</strong> {data.spikes.worst.method} {data.spikes.worst.endpoint} moved {KB(data.spikes.worst.today_bytes)} against a median of {KB(data.spikes.worst.median_bytes)}
            {Number.isFinite(data.spikes.worst.factor) ? ` (${data.spikes.worst.factor}×)` : ' (no history)'} over {N(data.spikes.worst.requests)} requests.
            <div className="muted mt-1 text-xs">{data.spikes.note}</div>
          </div>
        )}

        {data.guards?.readPersistBlocked > 0 && (
          <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800" role="alert">
            <strong>Read-only guard blocked {N(data.guards.readPersistBlocked)} snapshot upload(s)</strong> since this process started. Last: {data.guards.lastReadViolation}. The change was not uploaded; report it, because a read-only endpoint should never modify a database.
          </div>
        )}

        {thisMonth && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <strong>{thisMonth.month}</strong>: {KB(Number(thisMonth.pg_down_bytes) + Number(thisMonth.pg_up_bytes))} of database transfer measured over {N(thisMonth.requests)} requests.
            <span className="muted"> Compare with your provider&apos;s data-transfer meter for the billed figure.</span>
          </div>
        )}

        <Table title="By endpoint" head={['Endpoint', 'Method', 'Access', 'Requests', '304', 'DB reads', 'DB writes', 'Responses', 'DB down', 'DB up', 'Avg ms']}
          rows={(data.endpoints || []).map((r: any) => [r.endpoint, r.method, r.access || '', N(r.requests), N(r.cached), N(r.db_reads), N(r.db_writes), KB(r.response_bytes), KB(r.pg_down_bytes), KB(r.pg_up_bytes), r.requests ? Math.round(r.total_ms / r.requests) : 0])} />
        {data.access?.length ? <Table title="By declared access class" head={['Access', 'Requests', 'DB reads', 'DB writes', 'Blocked uploads', 'DB down', 'DB up']}
          rows={data.access.map((r: any) => [r.access, N(r.requests), N(r.db_reads), N(r.db_writes), N(r.blocked), KB(r.pg_down_bytes), KB(r.pg_up_bytes)])} /> : null}
        <Table title="By day" head={['Day', 'Requests', '304', 'Responses', 'DB down', 'DB up']}
          rows={(data.daily || []).map((r: any) => [r.day, N(r.requests), N(r.cached), KB(r.response_bytes), KB(r.pg_down_bytes), KB(r.pg_up_bytes)])} />
        <Table title="Stored snapshots" head={['Database', 'Version', 'File size', 'Chunk size', 'Chunks', 'Stored (compressed)', 'Base blob', 'Updated']}
          rows={(data.snapshots || []).map((r: any) => [r.db_key, r.version, KB(r.size_bytes), `${Number(r.chunk_size || 0) / 1024} KiB`, N(r.chunks), KB(r.stored_bytes), KB(r.base_bytes), r.updated_at])} />
      </>)}
    </section>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (<div className="rounded-xl border border-slate-200 p-3">
    <div className="muted text-xs font-semibold uppercase tracking-wide">{label}</div>
    <div className="text-xl font-black">{value}</div>
    {note ? <div className="muted text-xs">{note}</div> : null}
  </div>);
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (<div className="grid gap-2">
    <h3 className="text-sm font-bold">{title}</h3>
    {!rows.length ? <p className="muted rounded-lg border border-dashed border-slate-200 p-3 text-sm">No measurements recorded yet.</p> :
      <div className="table-wrap overflow-x-auto"><table className="table w-full text-sm">
        <thead><tr>{head.map((h) => <th key={h} className="text-left">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? 'font-medium' : ''}>{c}</td>)}</tr>)}</tbody>
      </table></div>}
  </div>);
}
