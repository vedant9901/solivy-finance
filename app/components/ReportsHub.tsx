'use client';
// Shared deduplicated, ETag-conditional, abortable request layer (app/lib/client-http.ts).
import { getJson, invalidateClientCache } from '../lib/client-http';
/**
 * Reports hub (v2.7.0) — grouped report cards with search, favourites (stars), permission-based
 * visibility, a parameter bar, drill-down, CSV/XLSX/PDF export, Report Groups and a budget editor.
 * All amounts from /api/reports are integer paise.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FiBarChart2, FiBook, FiBox, FiCalendar, FiCheckCircle, FiClipboard, FiClock, FiCopy, FiDollarSign, FiDownload, FiFileText, FiGrid, FiHelpCircle, FiLayers, FiList, FiPercent, FiSearch, FiShield, FiShoppingCart, FiStar, FiTrendingUp, FiUsers, FiArrowLeft, FiBriefcase, FiCreditCard, FiPackage, FiFile, FiAward, FiHome, FiTable, FiZap } from 'react-icons/fi';

type Meta = { id: string; title: string; group: string; description: string; icon: string; kind: string; permission: string[]; params: string[] };
type Col = { key: string; label: string; type?: string };
type Table = { title: string; subtitle?: string; columns: Col[]; rows: any[]; totals?: any; notes?: string[]; sections?: Table[] };
const GROUP_ORDER = ['Company & Financial', 'Customers & Receivables', 'Vendors & Payables', 'Sales', 'Purchases', 'Inventory', 'Sales Tax (GST)', 'Accountant & Taxes', 'Lists', 'Combined / Multi-company'];
const ICONS: Record<string, ReactNode> = { scale: <FiAward />, bars: <FiBarChart2 />, sparkle: <FiZap />, cash: <FiCreditCard />, trend: <FiTrendingUp />, wallet: <FiDollarSign />, calculator: <FiGrid />, table: <FiTable />, calendar: <FiCalendar />, pages: <FiCopy />, clock: <FiClock />, doc: <FiFileText />, question: <FiHelpCircle />, list: <FiList />, id: <FiClipboard />, rupee: <FiDollarSign />, cart: <FiShoppingCart />, clipboard: <FiClipboard />, box: <FiBox />, cube: <FiPackage />, percent: <FiPercent />, filedoc: <FiFile />, book: <FiBook />, shield: <FiShield />, check: <FiCheckCircle />, users: <FiUsers />, store: <FiBriefcase />, building: <FiHome /> };
const KIND: Record<string, [string, string]> = { statement: ['Statement', 'bg-teal-50 text-teal-800'], management: ['Management', 'bg-slate-100 text-slate-700'], estimate: ['Estimate', 'bg-amber-50 text-amber-800'], 'statutory-support': ['Filing support · CA review', 'bg-rose-50 text-rose-800'], list: ['List', 'bg-slate-100 text-slate-700'], control: ['Control', 'bg-indigo-50 text-indigo-800'] };

function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function fyOf(date: string) { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); const s = m >= 4 ? y : y - 1; return { start: `${s}-04-01`, label: `${s}-${String((s + 1) % 100).padStart(2, '0')}` }; }
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmt(c: Col, v: any) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') { const n = Number(v) / 100; return n < 0 ? `(${inr.format(-n)})` : inr.format(n); }
  if (c.type === 'pct') return `${Number(v).toFixed(2)}%`;
  if (c.type === 'number') return typeof v === 'number' ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(v) : String(v);
  return String(v);
}


function ReportTable({ t, onDrill }: { t: Table; onDrill?: (row: any, col: Col) => void }) {
  const sections = t.sections?.length ? t.sections : [t];
  return (<div className="grid gap-5">
    {sections.map((s, si) => (<div key={si} className="grid gap-2">
      {t.sections?.length ? <h3 className="text-sm font-bold text-slate-800">{s.title}</h3> : null}
      {s.rows.length === 0 ? <p className="muted rounded-lg border border-dashed border-slate-200 p-4 text-sm">No records for the selected period.</p> :
        <div className="table-wrap overflow-x-auto"><table className="table w-full text-sm">
          <thead><tr>{s.columns.map((c) => <th key={c.key} className={c.type === 'money' || c.type === 'number' || c.type === 'pct' ? 'text-right' : 'text-left'}>{c.label}</th>)}</tr></thead>
          <tbody>
            {s.rows.slice(0, 2000).map((r, i) => (<tr key={i}>{s.columns.map((c) => {
              const drill = onDrill && ((c.key === 'name' && r.code) || ((c.key === 'party' || c.key === 'customer') && (r.party_key || r.key)));
              const neg = c.type === 'money' && Number(r[c.key]) < 0;
              return <td key={c.key} className={`${c.type === 'money' || c.type === 'number' || c.type === 'pct' ? 'text-right tabular-nums' : ''} ${neg ? 'text-rose-700' : ''}`}>
                {drill ? <button type="button" className="text-left font-semibold text-teal-700 hover:underline" onClick={() => onDrill!(r, c)}>{fmt(c, r[c.key])}</button> : fmt(c, r[c.key])}</td>;
            })}</tr>))}
            {s.totals ? <tr className="font-bold">{s.columns.map((c) => <td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'text-right tabular-nums' : ''}>{fmt(c, s.totals[c.key])}</td>)}</tr> : null}
          </tbody></table>{s.rows.length > 2000 ? <p className="muted p-2 text-xs">Showing the first 2,000 rows. Export for the complete report.</p> : null}</div>}
    </div>))}
    {t.notes?.length ? <ul className="grid gap-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{t.notes.map((n, i) => <li key={i}>• {n}</li>)}</ul> : null}
  </div>);
}

function BudgetEditor({ fy, onSaved }: { fy: string; onSaved: () => void }) {
  const [cfg, setCfg] = useState<any>(null); const [vals, setVals] = useState<Record<string, string>>({}); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { getJson(`/api/budgets?fy=${fy}`).then((j) => { setCfg(j); const v: any = {}; for (const l of j.lines) v[`${l.account_code}|${l.month}`] = String(l.amount); setVals(v); }).catch((e) => setMsg(e.message)); }, [fy]);
  if (!cfg) return <p className="muted text-sm">{msg || 'Loading budget…'}</p>;
  const save = async () => { setBusy(true); setMsg(''); try { const lines = Object.entries(vals).filter(([, v]) => v !== '').map(([k, v]) => { const [account_code, month] = k.split('|'); return { account_code, month, amount: Number(v) }; }); if (!lines.length) throw new Error('Enter at least one amount.'); await getJson('/api/budgets', { method: 'POST', body: JSON.stringify({ fy, lines }), noCache: true });
      invalidateClientCache(); setMsg('Budget saved.'); onSaved(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
  return (<div className="grid gap-3">
    <div className="table-wrap overflow-x-auto"><table className="table text-xs"><thead><tr><th className="text-left">Account</th>{cfg.months.map((m: string) => <th key={m}>{m}</th>)}</tr></thead><tbody>
      {cfg.accounts.map((a: any) => <tr key={a.code}><td className="whitespace-nowrap font-semibold">{a.code} {a.name}</td>{cfg.months.map((m: string) => <td key={m}><input aria-label={`${a.name} ${m}`} inputMode="decimal" className="w-24 rounded border border-slate-200 px-1 py-0.5 text-right" value={vals[`${a.code}|${m}`] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [`${a.code}|${m}`]: e.target.value.replace(/[^0-9.]/g, '') }))} /></td>)}</tr>)}
    </tbody></table></div>
    <div className="flex items-center gap-3"><button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save budget'}</button>{msg ? <span className="text-sm">{msg}</span> : null}</div>
  </div>);
}

export default function ReportsHub({ legacy, onLegacyOpen }: { legacy?: ReactNode; onLegacyOpen?: (open: boolean) => void }) {
  const [view, setView] = useState<'hub' | 'legacy'>('hub');
  // The legacy MIS view reads whole ledger/purchase/payment tables from /api/data. Those modules
  // are fetched only while it is open (v2.7.1: the Reports tab cost 635 KB before, ~30 KB now).
  useEffect(() => { onLegacyOpen?.(view === 'legacy'); }, [view, onLegacyOpen]);
  const [catalog, setCatalog] = useState<Meta[]>([]); const [fav, setFav] = useState<string[]>([]);
  const [q, setQ] = useState(''); const [onlyFav, setOnlyFav] = useState(false); const [err, setErr] = useState('');
  const [open, setOpen] = useState<Meta | null>(null); const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null); const [loading, setLoading] = useState(false); const [editBudget, setEditBudget] = useState(false);
  const [accounts, setAccounts] = useState<Array<{ code: string; name: string }>>([]); const [orgs, setOrgs] = useState<number[]>([]);

  useEffect(() => { getJson('/api/reports').then((j) => { setCatalog(j.reports); setFav(j.favorites || []); }).catch((e) => setErr(e.message)); }, []);
  const defaults = useCallback((m: Meta) => { const t = today(), fy = fyOf(t); const p: Record<string, string> = {}; if (m.params.includes('from')) p.from = fy.start; if (m.params.includes('to')) p.to = t; if (m.params.includes('as_of')) p.as_of = t; if (m.params.includes('fy')) p.fy = fy.label; return p; }, []);
  const query = (p: Record<string, string>) => Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const run = useCallback(async (m: Meta, p: Record<string, string>, ids: number[] = orgs) => {
    setLoading(true); setErr('');
    try {
      // 'run' group: a new run cancels the one it replaces, so changing a filter twice transfers once.
      const j = m.id === 'report-groups' ? await getJson(`/api/reports/group?${query({ ...p, company_ids: ids.join(',') })}`, { group: 'run' }) : await getJson(`/api/reports?id=${m.id}&${query(p)}`, { group: 'run' });
      setResult(j);
      if (m.id === 'report-groups' && !ids.length) setOrgs(j.meta.organizations.map((o: any) => Number(o.id)));
    } catch (e: any) { setErr(e.message); setResult(null); } finally { setLoading(false); }
  }, [orgs]);
  const openReport = (m: Meta, extra: Record<string, string> = {}) => {
    const p = { ...defaults(m), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) }; setOpen(m); setParams(p); setResult(null); setEditBudget(false);
    if (m.id === 'management-package') return;
    run(m, p);
    if (m.params.includes('account') && !accounts.length) getJson('/api/reports?id=account-list').then((j) => setAccounts(j.data.rows.map((r: any) => ({ code: r.code, name: r.name })))).catch(() => {});
  };
  const toggleFav = async (id: string) => { const on = !fav.includes(id); setFav((f) => on ? [...f, id] : f.filter((x) => x !== id)); try { const j = await getJson('/api/reports', { method: 'POST', body: JSON.stringify({ action: 'favorite', report_id: id, on }), noCache: true }); setFav(j.favorites); invalidateClientCache(); } catch (e: any) { setErr(e.message); } };
  const visible = useMemo(() => catalog.filter((m) => (!onlyFav || fav.includes(m.id)) && (!q || `${m.title} ${m.description} ${m.group}`.toLowerCase().includes(q.toLowerCase()))), [catalog, fav, onlyFav, q]);
  const drill = (row: any, col: Col) => {
    const gl = catalog.find((m) => m.id === 'general-ledger'), cd = catalog.find((m) => m.id === 'customer-detail');
    if (col.key === 'name' && row.code && gl) openReport(gl, { account: String(row.code).split('.').length > 2 ? String(row.code).split('.').slice(0, 1).concat(String(row.code).split('.').slice(2)).join('.') : String(row.code), from: params.from || '', to: params.to || params.as_of || '' });
    else if ((row.party_key || row.key) && cd) openReport(cd, { party: row.party_key || row.key, from: params.from || '', to: params.to || '' });
  };
  const exportUrl = (fmtName: string) => open?.id === 'report-groups' ? `/api/reports/group?${query({ ...params, company_ids: orgs.join(','), format: fmtName })}` : `/api/reports?id=${open?.id}&${query({ ...params, format: fmtName })}`;

  if (view === 'legacy') return (<div className="grid gap-4"><div><button type="button" className="btn border border-slate-200 bg-white text-xs" onClick={() => setView('hub')}><FiArrowLeft className="mr-1 inline" />Back to Reports</button></div>{legacy}</div>);

  if (open) return (<div className="grid gap-4">
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn border border-slate-200 bg-white text-xs" onClick={() => { setOpen(null); setResult(null); }}><FiArrowLeft className="mr-1 inline" />All reports</button>
      <h2 className="text-xl font-black">{open.title}</h2>
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${KIND[open.kind]?.[1] || ''}`}>{KIND[open.kind]?.[0] || open.kind}</span>
      <button type="button" aria-label={fav.includes(open.id) ? 'Unstar report' : 'Star report'} className="ml-auto text-lg" onClick={() => toggleFav(open.id)}><FiStar className={fav.includes(open.id) ? 'fill-amber-400 text-amber-500' : 'text-slate-400'} /></button>
    </div>
    <p className="muted -mt-2 text-sm">{open.description}</p>
    <form className="card flex flex-wrap items-end gap-3 p-3" onSubmit={(e) => { e.preventDefault(); if (open.id !== 'management-package') run(open, params); }}>
      {open.params.includes('from') ? <label className="grid gap-1 text-xs font-semibold">From<input type="date" required className="rounded border border-slate-200 px-2 py-1" value={params.from || ''} onChange={(e) => setParams({ ...params, from: e.target.value })} /></label> : null}
      {open.params.includes('to') ? <label className="grid gap-1 text-xs font-semibold">To<input type="date" required className="rounded border border-slate-200 px-2 py-1" value={params.to || ''} onChange={(e) => setParams({ ...params, to: e.target.value })} /></label> : null}
      {open.params.includes('as_of') ? <label className="grid gap-1 text-xs font-semibold">As of<input type="date" required className="rounded border border-slate-200 px-2 py-1" value={params.as_of || ''} onChange={(e) => setParams({ ...params, as_of: e.target.value })} /></label> : null}
      {open.params.includes('fy') ? <label className="grid gap-1 text-xs font-semibold">Financial year<select className="rounded border border-slate-200 px-2 py-1" value={params.fy} onChange={(e) => setParams({ ...params, fy: e.target.value })}>{[0, 1, 2].map((i) => { const y = Number(fyOf(today()).label.slice(0, 4)) - i + 1; const l = `${y - 1}-${String(y % 100).padStart(2, '0')}`; return <option key={l} value={l}>{l}</option>; })}</select></label> : null}
      {open.params.includes('account') ? <label className="grid gap-1 text-xs font-semibold">Account<select className="max-w-xs rounded border border-slate-200 px-2 py-1" value={params.account || ''} onChange={(e) => setParams({ ...params, account: e.target.value })}><option value="">All accounts</option>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label> : null}
      {open.params.includes('weeks') ? <label className="grid gap-1 text-xs font-semibold">Weeks<input type="number" min={4} max={26} className="w-20 rounded border border-slate-200 px-2 py-1" value={params.weeks || '13'} onChange={(e) => setParams({ ...params, weeks: e.target.value })} /></label> : null}
      {open.params.includes('user') ? <label className="grid gap-1 text-xs font-semibold">User<input className="rounded border border-slate-200 px-2 py-1" value={params.user || ''} onChange={(e) => setParams({ ...params, user: e.target.value })} /></label> : null}
      {open.id === 'report-groups' && result?.meta?.available ? <fieldset className="grid gap-1 text-xs font-semibold">Organizations<div className="flex flex-wrap gap-2">{result.meta.available.map((o: any) => <label key={o.id} className="flex items-center gap-1 font-normal"><input type="checkbox" checked={orgs.includes(Number(o.id))} onChange={(e) => setOrgs((x) => e.target.checked ? [...x, Number(o.id)] : x.filter((y) => y !== Number(o.id)))} />{o.name}</label>)}</div></fieldset> : null}
      {open.id !== 'management-package' ? <button type="submit" className="btn primary" disabled={loading}>{loading ? 'Running…' : 'Run report'}</button> : null}
      <div className="ml-auto flex flex-wrap gap-2">
        {open.id === 'management-package'
          ? <a className="btn primary" href={exportUrl('pdf')}><FiDownload className="mr-1 inline" />Download PDF package</a>
          : ['pdf', 'xlsx', 'csv'].map((f) => <a key={f} className="btn border border-slate-200 bg-white text-xs" href={exportUrl(f)}><FiDownload className="mr-1 inline" />{f.toUpperCase()}</a>)}
        {open.id === 'budget-overview' ? <button type="button" className="btn border border-slate-200 bg-white text-xs" onClick={() => setEditBudget((v) => !v)}>{editBudget ? 'Close editor' : 'Edit budget'}</button> : null}
      </div>
    </form>
    {err ? <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{err}</div> : null}
    {editBudget ? <div className="card p-4"><BudgetEditor fy={params.fy} onSaved={() => run(open, params)} /></div> : null}
    {open.id === 'management-package' ? <div className="card p-4 text-sm"><p>The package contains a cover page, table of contents and: Balance Sheet, Income Statement, Cash Flow, Profit Insights, AR Aging, AP Aging, Cash Flow Forecast and Trial Balance for the selected period. Reports you are not permitted to view are omitted.</p></div> : null}
    {loading ? <div className="card p-6 text-sm muted" aria-busy="true">Preparing report…</div> : null}
    {result?.table && !loading ? <div className="card p-4"><div className="mb-3"><h3 className="font-bold">{result.table.title}</h3>{result.table.subtitle ? <p className="muted text-xs">{result.table.subtitle}</p> : null}</div><ReportTable t={result.table} onDrill={drill} /></div> : null}
  </div>);

  const groups = GROUP_ORDER.filter((g) => visible.some((m) => m.group === g));
  return (<div className="grid gap-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-2xl font-black">Reports</h2><p className="muted text-sm">Browse and run reports. Star a report to keep it in Starred.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative"><span className="sr-only">Search reports</span><FiSearch className="pointer-events-none absolute left-2 top-2.5 text-slate-400" /><input className="w-64 rounded-lg border border-slate-200 py-2 pl-8 pr-2 text-sm" placeholder="Search reports…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button type="button" aria-pressed={onlyFav} className={`btn text-xs ${onlyFav ? 'primary' : 'border border-slate-200 bg-white'}`} onClick={() => setOnlyFav((v) => !v)}><FiStar className="mr-1 inline" />Starred ({fav.length})</button>
        {legacy ? <button type="button" className="btn border border-slate-200 bg-white text-xs" onClick={() => setView('legacy')}><FiLayers className="mr-1 inline" />MIS &amp; Registers</button> : null}
      </div>
    </div>
    {err ? <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{err}</div> : null}
    {!catalog.length && !err ? <div className="card p-6 text-sm muted">Loading reports…</div> : null}
    {catalog.length > 0 && !groups.length ? <div className="card p-6 text-sm muted">{onlyFav ? 'No starred reports yet. Use the star on any report card.' : 'No reports match your search.'}</div> : null}
    {groups.map((g) => (<section key={g} className="grid gap-2">
      <h3 className="text-sm font-bold text-slate-700">{g}</h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.filter((m) => m.group === g).map((m) => (<div key={m.id} className="card relative flex gap-3 p-4 transition hover:shadow-md">
          <span className="mt-0.5 text-lg text-slate-500">{ICONS[m.icon] || <FiFileText />}</span>
          <button type="button" className="flex-1 text-left" onClick={() => openReport(m)}><span className="block font-semibold text-slate-900">{m.title}</span><span className="muted mt-1 block text-xs leading-relaxed">{m.description}</span></button>
          <button type="button" aria-label={fav.includes(m.id) ? `Unstar ${m.title}` : `Star ${m.title}`} className="self-start text-lg" onClick={() => toggleFav(m.id)}><FiStar className={fav.includes(m.id) ? 'fill-amber-400 text-amber-500' : 'text-slate-300 hover:text-slate-500'} /></button>
        </div>))}
      </div>
    </section>))}
  </div>);
}
