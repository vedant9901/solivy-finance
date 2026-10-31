'use client';
import React, {useEffect, useMemo, useState} from 'react';
import { Counter, SkeletonCards } from './ui';
import '../dashboard.css';
import {FiArrowDownLeft, FiArrowUpRight, FiChevronDown, FiCreditCard, FiInbox, FiRefreshCw, FiSearch, FiTrendingDown, FiTrendingUp} from 'react-icons/fi';
import {money} from '../../lib/utils';

/**
 * SOLIVY executive dashboard (v2.6.0).
 *
 * Every figure on this page is read from SOLIVY records:
 *  - /api/group-mis  -> totals, monthly cash movement, top parties (authorised companies only)
 *  - /api/data       -> accounts, receipts, payments, purchases, receivables, overdue list (current company)
 * Nothing is estimated or defaulted to a made-up value. When a figure cannot be derived
 * (e.g. no prior-month value to compare with) the UI shows "—" or hides the comparison.
 */

type View = 'overview' | 'activity' | 'trends' | 'reports';
type Props = {
  data: any;
  money?: (v: number) => string;
  onReceive: () => void;
  onOpenTab: (tab: string) => void;
  cardAccess?: string[];
  role?: string;
  api: (path: string, opt?: any) => Promise<any>;
  companyId: number;
  mode: 'LIVE' | 'TEST';
};

const num = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function compact(v: number): string {
  const sym = money(0).replace(/[0-9.,\s ]/g, '');
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const trim = (x: number) => String(Number(x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)));
  if (sym === '₹') {
    if (a >= 1e7) return `${sign}${sym}${trim(a / 1e7)} Cr`;
    if (a >= 1e5) return `${sign}${sym}${trim(a / 1e5)} L`;
    if (a >= 1e3) return `${sign}${sym}${trim(a / 1e3)}k`;
    return `${sign}${sym}${trim(a)}`;
  }
  if (a >= 1e9) return `${sign}${sym}${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}${sym}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}${sym}${trim(a / 1e3)}k`;
  return `${sign}${sym}${trim(a)}`;
}

/** Round an axis maximum up to a "nice" 1/2/2.5/5/10 x 10^k value. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * p;
}

function Change({cur, prev, goodWhenUp = true, label = 'vs last month'}: {cur: number; prev: number; goodWhenUp?: boolean; label?: string}) {
  if (!prev) return <span className="sd-muted-note">No prior-month value</span>;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  const good = up === goodWhenUp;
  return (
    <span className="sd-change-wrap">
      <span className={`sd-chip ${good ? 'sd-chip-good' : 'sd-chip-bad'}`}>{up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%</span>
      <span className="sd-muted-note">{label}</span>
    </span>
  );
}

function statusTone(status: any): string {
  const s = String(status || '').toUpperCase();
  if (['POSTED', 'COMPLETED', 'PAID', 'RECEIVED', 'CLEARED', 'ACTIVE', 'MATCHED'].includes(s)) return 'good';
  if (['PENDING', 'OPEN', 'PARTIAL', 'PARTIALLY_PAID', 'IN_PROGRESS', 'DRAFT'].includes(s)) return 'warn';
  if (['REVERSED', 'CANCELLED', 'VOID', 'FAILED', 'REJECTED', 'OVERDUE'].includes(s)) return 'bad';
  return 'neutral';
}

const prettyStatus = (s: any) => {
  const t = String(s || '').replace(/_/g, ' ').toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
};

const fmtDate = (d: any) => {
  const raw = String(d || '').slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw || '—';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dt.toLocaleDateString('en-IN', {day: '2-digit', month: 'short', year: 'numeric'});
};

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function ExecutiveDashboard({data, onReceive, onOpenTab, api, companyId, mode}: Props) {
  const [companyOptions, setCompanyOptions] = useState<any[]>([]);
  const [selected, setSelected] = useState<number[]>([companyId]);
  const [group, setGroup] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<View>('overview');
  const [period, setPeriod] = useState<6 | 12>(6);
  const [metric, setMetric] = useState<'cashflow' | 'inflow' | 'outflow'>('cashflow');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('ALL');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [userName, setUserName] = useState('');

  useEffect(() => {
    try {
      const u = window.sessionStorage.getItem('aksh-username') || '';
      setUserName(u ? u.charAt(0).toUpperCase() + u.slice(1) : '');
    } catch {
      setUserName('');
    }
  }, []);

  useEffect(() => {
    setSelectedMonth('');
  }, [companyId]);

  /**
   * v2.7.1: the organizations to consolidate are derived, not kept in a second state. Before,
   * switching organization left `selected` holding the previous one for a render, so every mount
   * fired three /api/group-mis requests (two of them for the wrong organization) and each one
   * hydrated an organization snapshot.
   */
  const consolidated = selected.length && selected.includes(companyId) ? selected : [companyId];
  const consolidatedKey = consolidated.join(',');

  useEffect(() => {
    let live = true;
    const run = async () => {
      setLoading(true);
      setError('');
      try {
        if (!companyId) return;
        const j = await api(`/group-mis?company_ids=${consolidatedKey}&mode=${mode}`);
        if (!live) return;
        setGroup(j);
        setCompanyOptions(j.available_companies || []);
      } catch (e: any) {
        if (live) setError(e?.message || 'Unable to load dashboard figures');
      } finally {
        if (live) setLoading(false);
      }
    };
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consolidatedKey, mode, reloadKey]);

  const totals = group?.totals || {};
  const hasTotals = !!group;

  const transactions = useMemo(() => {
    const rows: any[] = [
      ...(data.moneyIn || []).map((r: any) => ({date: r.receipt_date || r.payment_date, type: 'Receipt', reference: r.reference_no || r.receipt_no, party: r.party_name || r.receipt_type, amount: num(r.amount), status: r.status, flow: 'in'})),
      ...(data.moneyOut || []).map((r: any) => ({date: r.payment_date, type: 'Withdrawal', reference: r.reference_no, party: r.party_name || r.out_type, amount: num(r.amount), status: r.status, flow: 'out'})),
      ...(data.purchases || []).map((r: any) => ({date: r.purchase_date, type: 'Purchase', reference: r.sample_no || r.invoice_no, party: r.party_name, amount: num(r.net_payable), status: r.status, flow: 'out'})),
      ...(data.payments || []).map((r: any) => ({date: r.payment_date, type: 'Vendor payment', reference: r.payment_no, party: r.party_name, amount: num(r.net_paid || r.amount), status: r.status, flow: 'out'})),
      ...(data.receivables || []).filter((r: any) => num(r.received_amount) > 0).map((r: any) => ({date: r.received_date || r.bill_date, type: 'Receivable', reference: r.bill_no, party: r.party_name, amount: num(r.received_amount), status: r.status, flow: 'in'}))
    ];
    return rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }, [data]);

  const typeOptions = useMemo(() => Array.from(new Set(transactions.map((r: any) => r.type))) as string[], [transactions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactions.filter((r: any) => (type === 'ALL' || r.type === type) && (!q || `${r.date || ''} ${r.type} ${r.reference || ''} ${r.party || ''} ${r.status || ''}`.toLowerCase().includes(q)));
  }, [transactions, query, type]);

  const monthly = useMemo(() => {
    return Array.from({length: period}, (_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (period - 1 - i));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-IN', {month: 'short'});
      const full = d.toLocaleDateString('en-IN', {month: 'long', year: 'numeric'});
      const g = (group?.monthly_activity || []).find((x: any) => x.month === key);
      // Prefer the authorised multi-company aggregate. Fall back to the loaded
      // current-company records only when the aggregate has not loaded.
      const rows = g ? [] : transactions.filter((x: any) => String(x.date || '').slice(0, 7) === key);
      const inflow = g ? num(g.inflow) : rows.filter((x: any) => x.flow === 'in').reduce((a: number, x: any) => a + x.amount, 0);
      const outflow = g ? num(g.outflow) : rows.filter((x: any) => x.flow === 'out').reduce((a: number, x: any) => a + x.amount, 0);
      return {key, label, full, inflow, outflow, net: inflow - outflow, activity: g ? num(g.transactions) : rows.length};
    });
  }, [group, transactions, period]);

  const series: Array<'inflow' | 'outflow'> = metric === 'inflow' ? ['inflow'] : metric === 'outflow' ? ['outflow'] : ['inflow', 'outflow'];
  const peak = Math.max(0, ...monthly.flatMap((m) => series.map((k) => m[k])));
  const axisMax = niceMax(peak);
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => axisMax * f);
  const activeMonth = monthly.find((m) => m.key === selectedMonth) || monthly[monthly.length - 1];
  const anyMovement = monthly.some((m) => m.inflow || m.outflow);

  const receivable = num(totals.financing_receivable);
  const received = num(totals.financing_received);
  const outstandingRec = Math.max(0, receivable - received);
  const collectedPct = receivable > 0 ? Math.min(100, (received / receivable) * 100) : 0;
  const overdueRows: any[] = data.overdueReceivables || [];
  const overdueTotal = overdueRows.reduce((n: number, r: any) => n + num(r.outstanding), 0);
  const accounts: any[] = data.accounts || [];
  const companies = companyOptions.length ? companyOptions : [{id: companyId, name: 'Current company'}];

  const toggleCompany = (id: number, checked: boolean) =>
    setSelected(() => {
      const next = checked ? Array.from(new Set([...consolidated, id])) : consolidated.filter((x) => x !== id);
      return next.length ? next : [companyId];
    });

  const showHero = view === 'overview' || view === 'reports';
  const showChart = view === 'overview' || view === 'trends';
  const showActivity = view === 'overview' || view === 'activity';
  const showReports = view === 'overview' || view === 'reports';
  const activityRows = filtered.slice(0, view === 'activity' ? 30 : 8);

  const activityCard = (
    <section className="sd-card sd-span-2" aria-label="Recent activities">
      <div className="sd-card-head">
        <div>
          <h3 className="sd-h3">Recent activities</h3>
          <p className="sd-sub">Latest records for the open company · {transactions.length} loaded</p>
        </div>
        <div className="sd-tools">
          <label className="sd-search">
            <FiSearch aria-hidden="true" />
            <input aria-label="Search activities" placeholder="Search party, reference, date…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <select aria-label="Filter activity type" className="sd-select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="ALL">All types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="sd-table-wrap">
        <table className="sd-table">
          <thead>
            <tr><th>Reference</th><th>Activity</th><th>Party</th><th className="sd-num">Amount</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            {activityRows.map((r: any, i: number) => (
              <tr key={`${r.type}-${r.reference}-${i}`}>
                <td className="sd-ref">{r.reference || '—'}</td>
                <td>
                  <span className="sd-act">
                    <span className={`sd-act-ico ${r.flow === 'in' ? 'in' : 'out'}`}>{r.flow === 'in' ? <FiArrowDownLeft aria-hidden="true" /> : <FiArrowUpRight aria-hidden="true" />}</span>
                    {r.type}
                  </span>
                </td>
                <td className="sd-party">{r.party || '—'}</td>
                <td className="sd-num sd-strong">{money(r.amount)}</td>
                <td><span className={`sd-status ${statusTone(r.status)}`}><i />{prettyStatus(r.status)}</span></td>
                <td className="sd-date">{fmtDate(r.date)}</td>
              </tr>
            ))}
            {!activityRows.length && (
              <tr><td colSpan={6} className="sd-empty-cell"><FiInbox aria-hidden="true" /> {transactions.length ? 'No activity matches your search.' : 'No activity recorded yet for this company.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="sd-foot">
        <span>Showing {activityRows.length} of {filtered.length}</span>
        {view !== 'activity' && <button className="sd-link" onClick={() => setView('activity')}>View all activity →</button>}
        {view === 'activity' && <button className="sd-link" onClick={() => onOpenTab('reports')}>Open reports →</button>}
      </div>
    </section>
  );

  return (
    <div className="sd" data-view={view}>
      <header className="sd-top">
        <div>
          <h2 className="sd-greet">{greeting()}{userName ? `, ${userName}` : ''}</h2>
          <p className="sd-lede">Stay on top of your cash, receivables and follow-ups.{group?.as_of ? ` Updated ${new Date(group.as_of).toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit'})}.` : ''}</p>
        </div>
        <div className="sd-top-right">
          <nav className="sd-pills" aria-label="Dashboard view">
            {([['overview', 'Overview'], ['activity', 'Activity'], ['trends', 'Trends'], ['reports', 'Reports']] as Array<[View, string]>).map(([id, label]) => (
              <button key={id} className={view === id ? 'on' : ''} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
            ))}
          </nav>
          <div className="sd-picker">
            <button className="sd-picker-btn" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>
              {consolidated.length > 1 ? `${consolidated.length} companies` : '1 company'} <FiChevronDown aria-hidden="true" />
            </button>
            {pickerOpen && (
              <div className="sd-pop" role="dialog" aria-label="Companies to include">
                <div className="sd-pop-actions">
                  <button onClick={() => setSelected(companies.map((c: any) => Number(c.id)))}>Select all</button>
                  <button onClick={() => setSelected([companyId])}>Current only</button>
                </div>
                <div className="sd-pop-list">
                  {companies.map((c: any) => (
                    <label key={c.id}>
                      <input type="checkbox" checked={consolidated.includes(Number(c.id))} onChange={(e) => toggleCompany(Number(c.id), e.target.checked)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
                <p className="sd-pop-note">Only companies assigned to your account are listed. Amounts are added as stored — select companies that use the same currency.</p>
              </div>
            )}
          </div>
          <button className="sd-icon-btn" aria-label="Refresh dashboard" title="Refresh" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
            <FiRefreshCw aria-hidden="true" className={loading ? 'sd-spin' : ''} />
          </button>
        </div>
      </header>

      {error && (
        <div className="sd-alert" role="alert">
          <span>{error}</span>
          <button onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      )}
      {loading && !group && <><div className="sd-loading" aria-live="polite">Loading figures for the selected companies…</div><SkeletonCards count={4} /></>}

      {showHero && (
        <div className="sd-grid">
          <section className="sd-card sd-balance-card" aria-label="Total balance">
            <div className="sd-label">Total balance <span className="sd-tag">{consolidated.length > 1 ? `${consolidated.length} companies` : 'Bank + cash'}</span></div>
            <div className="sd-balance">{hasTotals ? <Counter value={num(totals.available_cash)} format={money} /> : '—'}</div>
            <div className="sd-change-wrap">
              {hasTotals ? (
                <>
                  <span className={`sd-chip ${num(totals.month_net) >= 0 ? 'sd-chip-good' : 'sd-chip-bad'}`}>{num(totals.month_net) >= 0 ? '↑' : '↓'} {money(Math.abs(num(totals.month_net)))}</span>
                  <span className="sd-muted-note">net movement this month</span>
                </>
              ) : (
                <span className="sd-muted-note">Waiting for data</span>
              )}
            </div>
            <div className="sd-btn-row">
              <button className="sd-btn-dark" onClick={() => onOpenTab('payments')}><FiArrowUpRight aria-hidden="true" /> Record payment</button>
              <button className="sd-btn-light" onClick={() => onOpenTab('money-in')}><FiArrowDownLeft aria-hidden="true" /> Record receipt</button>
            </div>
            <div className="sd-wallets">
              <div className="sd-wallets-head"><span>Accounts</span><b>{accounts.length ? `${accounts.length} total` : 'None to show'}</b></div>
              <div className="sd-wallet-grid">
                {accounts.slice(0, 3).map((a: any) => (
                  <button key={a.id} className="sd-wallet" onClick={() => onOpenTab('accounts')} title={`${a.account_name}${a.bank_name ? ' · ' + a.bank_name : ''}`}>
                    <span className="sd-wallet-type">{String(a.account_type || 'BANK').toLowerCase()}</span>
                    <span className="sd-wallet-name">{a.account_name}</span>
                    <b>{money(num(a.balance))}</b>
                  </button>
                ))}
                {!accounts.length && <div className="sd-wallet-empty">{hasTotals && num(totals.available_cash) !== 0 ? 'The account list is not available for your role.' : 'No bank or cash accounts added yet.'}</div>}
              </div>
              {accounts.length > 3 && <button className="sd-link" onClick={() => onOpenTab('accounts')}>+{accounts.length - 3} more accounts →</button>}
            </div>
          </section>

          <section className="sd-kpis" aria-label="Key figures">
            <button className="sd-kpi sd-kpi-accent" onClick={() => onOpenTab('reports')}>
              <span className="sd-kpi-top"><span>Realised profit</span><FiTrendingUp aria-hidden="true" /></span>
              <b>{hasTotals ? <Counter value={num(totals.finance_profit_after_interest)} format={money} /> : '—'}</b>
              <small>Book profit {money(num(totals.book_profit))} less interest {money(num(totals.interest_paid))}</small>
            </button>
            <button className="sd-kpi" onClick={() => onOpenTab('reports')}>
              <span className="sd-kpi-top"><span>Outflow this month</span><FiTrendingDown aria-hidden="true" /></span>
              <b>{hasTotals ? <Counter value={num(totals.month_outflow)} format={money} /> : '—'}</b>
              {hasTotals && <Change cur={num(totals.month_outflow)} prev={num(totals.previous_month_outflow)} goodWhenUp={false} />}
            </button>
            <button className="sd-kpi" onClick={() => onOpenTab('reports')}>
              <span className="sd-kpi-top"><span>Inflow this month</span><FiTrendingUp aria-hidden="true" /></span>
              <b>{hasTotals ? <Counter value={num(totals.month_inflow)} format={money} /> : '—'}</b>
              {hasTotals && <Change cur={num(totals.month_inflow)} prev={num(totals.previous_month_inflow)} />}
            </button>
            <button className="sd-kpi" onClick={onReceive}>
              <span className="sd-kpi-top"><span>Receivables outstanding</span><FiCreditCard aria-hidden="true" /></span>
              <b>{hasTotals ? money(outstandingRec) : '—'}</b>
              <small>{hasTotals ? `${collectedPct.toFixed(0)}% of ${money(receivable)} collected` : ''}</small>
            </button>
          </section>

          {showChart && <div className="sd-chart-slot">{chartCard()}</div>}
        </div>
      )}

      {!showHero && showChart && <div className="sd-grid sd-grid-one">{chartCard()}</div>}

      {view === 'trends' && (
        <section className="sd-card" style={{marginTop: 16}}>
          <div className="sd-card-head"><div><h3 className="sd-h3">Monthly table</h3><p className="sd-sub">Cash movement per month, exactly as plotted</p></div></div>
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead><tr><th>Month</th><th className="sd-num">Inflow</th><th className="sd-num">Outflow</th><th className="sd-num">Net</th><th className="sd-num">Transactions</th></tr></thead>
              <tbody>
                {monthly.map((m) => (
                  <tr key={m.key}><td className="sd-strong">{m.full}</td><td className="sd-num">{money(m.inflow)}</td><td className="sd-num">{money(m.outflow)}</td><td className={`sd-num sd-strong ${m.net < 0 ? 'neg' : ''}`}>{money(m.net)}</td><td className="sd-num">{m.activity}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(showActivity || showReports) && (
        <div className="sd-grid sd-grid-lower">
          {showReports && (
            <div className="sd-stack">
              <section className="sd-card" aria-label="Collections and position">
                <div className="sd-card-head"><div><h3 className="sd-h3">Collections &amp; position</h3><p className="sd-sub">Financing receivables vs. money collected</p></div></div>
                <div className="sd-progress-row"><b>{hasTotals ? money(received) : '—'}</b><span>collected of {hasTotals ? money(receivable) : '—'}</span></div>
                <div className="sd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(collectedPct)} aria-label="Receivables collected"><i style={{width: `${collectedPct}%`}} /></div>
                <dl className="sd-dl">
                  <div><dt>Paid to vendors</dt><dd>{money(num(totals.paid_to_vendors))}</dd></div>
                  <div><dt>Vendor outstanding</dt><dd>{money(num(totals.vendor_outstanding))}</dd></div>
                  <div><dt>Book profit</dt><dd>{money(num(totals.book_profit))}</dd></div>
                  <div><dt>Interest paid</dt><dd>{money(num(totals.interest_paid))}</dd></div>
                  <div title="Active loan principal + book profit − interest. A management estimate, not bank cash or a credit limit."><dt>Funding available <em>indicative</em></dt><dd>{money(num(totals.funding_capacity_estimate))}</dd></div>
                  <div><dt>Overdue receivables</dt><dd className={overdueTotal > 0 ? 'neg' : ''}>{money(overdueTotal)}</dd></div>
                </dl>
              </section>
              <section className="sd-card" aria-label="Top parties">
                <div className="sd-card-head"><div><h3 className="sd-h3">Top parties</h3><p className="sd-sub">By posted purchase value</p></div><button className="sd-link" onClick={() => onOpenTab('parties')}>Parties →</button></div>
                <ul className="sd-list">
                  {(group?.top_parties || []).slice(0, 5).map((p: any, i: number) => (
                    <li key={`${p.company_id}-${p.party_name}-${i}`}>
                      <span className="sd-avatar">{String(p.party_name || '?').charAt(0).toUpperCase()}</span>
                      <span className="sd-list-main"><b>{p.party_name}</b><small>{selected.length > 1 ? `${p.company_name} · ` : ''}Outstanding {money(num(p.outstanding))}</small></span>
                      <span className="sd-strong">{compact(num(p.purchase_value))}</span>
                    </li>
                  ))}
                  {!(group?.top_parties || []).length && <li className="sd-empty-li">No posted purchases yet.</li>}
                </ul>
              </section>
            </div>
          )}
          {showActivity && activityCard}
        </div>
      )}

      {showReports && (
        <section className="sd-card" style={{marginTop: 16}} aria-label="Overdue receivables">
          <div className="sd-card-head">
            <div><h3 className="sd-h3">Overdue receivables</h3><p className="sd-sub">Past-due amounts needing follow-up · current company</p></div>
            <div className="sd-tools"><span className={`sd-chip ${overdueTotal > 0 ? 'sd-chip-bad' : 'sd-chip-good'}`}>{money(overdueTotal)} overdue</span><button className="sd-link" onClick={onReceive}>View receivables →</button></div>
          </div>
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead><tr><th>Sample / bill</th><th>Party</th><th>Due date</th><th className="sd-num">Days overdue</th><th className="sd-num">Outstanding</th></tr></thead>
              <tbody>
                {overdueRows.slice(0, 8).map((r: any, i: number) => (
                  <tr key={`${r.id}-${i}`}><td className="sd-ref">{r.sample_no || r.bill_no || '—'}</td><td className="sd-party">{r.party_name}</td><td className="sd-date">{fmtDate(r.due_date)}</td><td className="sd-num"><span className="sd-status bad"><i />{num(r.days_overdue)} d</span></td><td className="sd-num sd-strong">{money(num(r.outstanding))}</td></tr>
                ))}
                {!overdueRows.length && <tr><td colSpan={5} className="sd-empty-cell"><FiInbox aria-hidden="true" /> Nothing overdue. </td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );

  function chartCard() {
    return (
      <section className="sd-card sd-chart" aria-label="Cash flow">
        <div className="sd-card-head">
          <div>
            <h3 className="sd-h3">Cash flow</h3>
            <p className="sd-sub">Money in vs. money out, by month</p>
          </div>
          <div className="sd-tools">
            <div className="sd-seg" role="group" aria-label="Period">
              {([6, 12] as const).map((n) => (
                <button key={n} className={period === n ? 'on' : ''} aria-pressed={period === n} onClick={() => { setPeriod(n); setSelectedMonth(''); }}>{n}M</button>
              ))}
            </div>
            <select aria-label="Chart series" className="sd-select" value={metric} onChange={(e) => setMetric(e.target.value as any)}>
              <option value="cashflow">In + out</option>
              <option value="inflow">Inflow only</option>
              <option value="outflow">Outflow only</option>
            </select>
          </div>
        </div>
        <div className="sd-legend"><span><i className="in" />Inflow</span><span><i className="out" />Outflow</span></div>
        <div className="sd-plot">
          <div className="sd-yaxis" aria-hidden="true">{ticks.map((t, i) => <span key={i}>{t === 0 ? '0' : peak > 0 ? compact(t) : ''}</span>)}</div>
          <div className="sd-plot-area">
            <div className="sd-gridlines" aria-hidden="true">{ticks.map((_, i) => <span key={i} />)}</div>
            <div className="sd-bars">
              {monthly.map((m) => (
                <button key={m.key} className={`sd-col ${activeMonth?.key === m.key ? 'on' : ''}`} onClick={() => setSelectedMonth(m.key)} aria-label={`${m.full}: inflow ${money(m.inflow)}, outflow ${money(m.outflow)}`} title={`${m.full}\nInflow ${money(m.inflow)}\nOutflow ${money(m.outflow)}`}>
                  <span className="sd-col-bars">
                    {series.map((k) => (
                      <span key={k} className={`sd-bar ${k}`} style={{height: `${m[k] > 0 ? Math.max(2, (m[k] / axisMax) * 100) : 0}%`}} />
                    ))}
                  </span>
                  <span className="sd-col-label">{m.label}</span>
                </button>
              ))}
            </div>
            {!anyMovement && <div className="sd-plot-empty">No cash movement recorded in this period.</div>}
          </div>
        </div>
        {activeMonth && (
          <div className="sd-month">
            <div><span className="sd-label">{activeMonth.full}</span><small>{activeMonth.activity} transactions</small></div>
            <div><span className="sd-label">Inflow</span><b>{money(activeMonth.inflow)}</b></div>
            <div><span className="sd-label">Outflow</span><b>{money(activeMonth.outflow)}</b></div>
            <div><span className="sd-label">Net</span><b className={activeMonth.net < 0 ? 'neg' : ''}>{money(activeMonth.net)}</b></div>
          </div>
        )}
        <p className="sd-fineprint">Cash movement from bank/cash ledgers across the selected companies; paired account-to-account transfers are excluded. Not audited turnover.</p>
      </section>
    );
  }
}
