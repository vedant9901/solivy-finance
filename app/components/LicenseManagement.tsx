'use client';
import { useEffect, useState } from 'react';
import { FiCheckCircle, FiLock, FiRefreshCw, FiShield } from 'react-icons/fi';

type LicenseModule = { id: string; name: string; description: string; included: boolean };
type LicenseOrganization = {
  companyId: number; organization: string; code: string; active: boolean; status: string; reason?: string;
  licenseId?: string; customer?: string; edition?: string; issuedAt?: string; expiresAt?: string;
  daysRemaining?: number; daysExpired?: number; perpetual?: boolean; modules: LicenseModule[];
};

const statusNames: Record<string, string> = {
  valid: 'Active', expired: 'Expired', missing: 'Not configured', invalid: 'Invalid license', not_assigned: 'Not assigned',
};
const statusStyles: Record<string, string> = {
  valid: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  expired: 'border-rose-200 bg-rose-50 text-rose-800',
  missing: 'border-amber-200 bg-amber-50 text-amber-800',
  invalid: 'border-amber-200 bg-amber-50 text-amber-800',
  not_assigned: 'border-amber-200 bg-amber-50 text-amber-800',
};
const prettyDate = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  : '—';

export default function LicenseManagement() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [enforcement, setEnforcement] = useState('off');
  const [organizations, setOrganizations] = useState<LicenseOrganization[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  const refresh = () => {
    setLoading(true);
    setError('');
    fetch('/api/license/status', { cache: 'no-store' })
      .then(async response => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'Unable to load licenses.');
        setEnforcement(String(json.enforcement || 'off'));
        const rows: LicenseOrganization[] = Array.isArray(json.organizations) ? json.organizations : [];
        setOrganizations(rows);
        setSelected(current => current && rows.some(org => org.companyId === current) ? current : (rows[0]?.companyId ?? null));
      })
      .catch(err => setError(err?.message || 'Unable to load license information.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  const current = organizations.find(org => org.companyId === selected) || null;
  const activeCount = organizations.filter(org => org.status === 'valid').length;
  const expiredCount = organizations.filter(org => org.status === 'expired').length;
  const attentionCount = organizations.filter(org => ['missing', 'invalid', 'not_assigned'].includes(org.status)).length;
  const label = (status: string) => statusNames[status] || status;
  const style = (status: string) => statusStyles[status] || statusStyles.missing;

  return <div className="space-y-5">
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 p-5 text-white shadow-xl sm:p-7">
      <div className="absolute -right-12 -top-16 h-56 w-56 rounded-full bg-orange-500/20 blur-3xl" />
      <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[.18em] text-orange-200"><FiShield size={14} /> License centre</div>
          <h2 className="mt-4 text-2xl font-black tracking-tight sm:text-3xl">License Management</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">Review every organization, license term and the modules included in its signed SOLIVY Finance license.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-3 py-1.5 text-xs font-bold ${enforcement === 'required' ? 'border-orange-300/30 bg-orange-400/15 text-orange-100' : 'border-white/15 bg-white/10 text-slate-200'}`}>Enforcement: {enforcement === 'required' ? 'Required' : enforcement === 'off' ? 'Off' : enforcement}</span>
          <button className="rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-bold hover:bg-white/15" onClick={refresh}><FiRefreshCw className="mr-2 inline" size={14} />Refresh</button>
        </div>
      </div>
    </section>

    {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800">{error}</div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryCard label="Organizations" value={organizations.length} note="All registered organizations" />
      <SummaryCard label="Active licenses" value={activeCount} note="Signed and currently valid" tone="green" />
      <SummaryCard label="Expired" value={expiredCount} note="Renewal required" tone="red" />
      <SummaryCard label="Needs attention" value={attentionCount} note="Missing, invalid or unassigned" tone="amber" />
    </div>

    {loading ? <div className="card p-8 text-center text-sm text-slate-500">Loading license details…</div> : organizations.length === 0 ? <div className="card p-8 text-center"><h3 className="font-black text-slate-900">No organizations found</h3><p className="mt-2 text-sm text-slate-500">Check the organization database and deployment configuration.</p></div> :
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,.85fr)_minmax(0,1.4fr)]">
        <section className="card min-w-0 overflow-hidden">
          <div className="border-b border-slate-200 p-4 sm:p-5"><h3 className="font-black text-slate-900">Organizations</h3><p className="mt-1 text-xs text-slate-500">Select an organization to review its license and included modules.</p></div>
          <div className="max-h-[680px] space-y-2 overflow-auto p-3 sm:p-4">
            {organizations.map(org => <button key={org.companyId} onClick={() => setSelected(org.companyId)} className={`w-full rounded-2xl border p-4 text-left transition ${selected === org.companyId ? 'border-indigo-300 bg-indigo-50 ring-2 ring-indigo-100' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}>
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-black text-slate-900">{org.organization}</p><p className="mt-1 text-xs text-slate-500">Org ID {org.companyId} · {org.code}{!org.active ? ' · Inactive organization' : ''}</p></div><span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-black ${style(org.status)}`}>{label(org.status)}</span></div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"><span>{org.edition ? `${org.edition} edition` : 'Edition not set'}</span><span>{org.status === 'valid' ? (org.perpetual ? 'Perpetual · no expiry' : `${org.daysRemaining} day(s) left`) : org.status === 'expired' ? `${org.daysExpired || 0} day(s) expired` : 'No active term'}</span></div>
            </button>)}
          </div>
        </section>

        {current ? <section className="min-w-0 space-y-4">
          <div className="card overflow-hidden">
            <div className="border-b border-slate-200 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-[.18em] text-indigo-600">Organization license</p><h3 className="mt-1 break-words text-xl font-black text-slate-950 sm:text-2xl">{current.organization}</h3><p className="mt-1 text-sm text-slate-500">{current.customer && current.customer !== current.organization ? `Licensed to ${current.customer} · ` : ''}Organization ID {current.companyId}</p></div><span className={`rounded-full border px-3 py-1.5 text-xs font-black ${style(current.status)}`}>{label(current.status)}</span></div></div>
            <div className="grid gap-px bg-slate-200 sm:grid-cols-2">
              <InfoCell label="License ID" value={current.licenseId || 'Not available'} mono />
              <InfoCell label="Edition" value={current.edition || 'Not configured'} capitalize />
              <InfoCell label="Issue date" value={prettyDate(current.issuedAt)} />
              <InfoCell label="Expiry date" value={current.perpetual ? 'Perpetual · no expiry' : prettyDate(current.expiresAt || undefined)} />
            </div>
            <div className="flex flex-col gap-3 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"><div><p className="text-xs font-bold text-slate-500">License validity</p><p className={`mt-1 text-2xl font-black ${current.status === 'valid' ? 'text-emerald-700' : current.status === 'expired' ? 'text-rose-700' : 'text-slate-700'}`}>{current.status === 'valid' ? (current.perpetual ? 'Perpetual license · no expiry' : `${current.daysRemaining} day(s) remaining`) : current.status === 'expired' ? `Expired ${current.daysExpired || 0} day(s) ago` : 'No valid term'}</p></div>{current.status === 'valid' && !current.perpetual && <div className="h-2 w-full max-w-48 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(3, Math.min(100, Number(current.daysRemaining || 0) / 365 * 100))}%` }} /></div>}</div>
            {current.reason && current.status !== 'valid' && <div className="border-t border-amber-100 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{current.reason}{current.status === 'expired' ? ' The administrator can continue to access this module; licensed finance APIs remain restricted.' : ''}</div>}
          </div>

          <div className="card min-w-0 p-4 sm:p-5"><div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-black text-slate-950">Included modules</h3><p className="mt-1 text-xs text-slate-500">Features encoded in the signed license token for this organization.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">{current.modules.filter(module => module.included).length} / {current.modules.length} included</span></div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">{current.modules.map(module => <div key={module.id} className={`flex min-w-0 items-start gap-3 rounded-xl border p-3 ${module.included ? 'border-emerald-200 bg-emerald-50/70' : 'border-slate-200 bg-slate-50 opacity-80'}`}><span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${module.included ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{module.included ? <FiCheckCircle size={15} /> : <FiLock size={14} />}</span><div className="min-w-0 flex-1"><div className="break-words text-sm font-bold text-slate-900">{module.name}</div><p className="mt-1 text-xs leading-5 text-slate-500">{module.description}</p><p className={`mt-1 text-[10px] font-black uppercase tracking-wider ${module.included ? 'text-emerald-700' : 'text-slate-500'}`}>{module.included ? 'Included' : 'Not included'}</p></div></div>)}</div>
          </div>
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm leading-6 text-indigo-950"><p className="font-black">Administrator guide · Generate or renew a license</p><ol className="mt-2 list-decimal space-y-1 pl-5"><li>Open PowerShell on the SOLIVY owner/development PC in your project folder.</li><li>Use the private signing key stored securely at <code>C:\SOLIVY-Keys\private.pem</code>. Never copy it to a customer PC or Vercel.</li><li>Use the organization ID shown on this screen; license company IDs must match exactly.</li><li>Generate the signed token with the command below, then configure it locally or in Vercel as described below.</li></ol><div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950"><p className="font-black">Fix “Missing, invalid or unassigned” on local</p><ul className="mt-1 list-disc space-y-1 pl-5"><li><strong>Missing:</strong> the app did not find a token for this company ID. Add the token to <code>.env.local</code> as shown below.</li><li><strong>Invalid:</strong> copy the complete one-line token from the generated license file. Make sure it was generated with this build's matching private key; do not edit the token.</li><li><strong>Not assigned:</strong> generate the token using the exact Organization ID displayed above in <code>--company-ids</code>, or list all intended IDs separated by commas.</li><li>After changing <code>.env.local</code>, stop and restart <code>npm run dev</code>, then click Refresh.</li></ul></div><p className="mt-3 font-bold">Time-limited license example (365 days)</p><pre className="mt-1 overflow-x-auto rounded-xl bg-slate-950 p-3 text-xs leading-5 text-slate-100">node scripts/license-tool.cjs issue --private-key "C:\SOLIVY-Keys\private.pem" --customer "Customer Legal Name" --company-ids {current.companyId} --days 365 --edition professional --features core,dashboard,accounts,account-movements,parties,purchase,payments,money-in,interest,funding,import,ledger,receivables,reports,bank,backup,gst,commercial-bills,document-settings,settings --out .\customer-license.txt</pre><p className="mt-3 font-bold">Perpetual license (no expiry)</p><pre className="mt-1 overflow-x-auto rounded-xl bg-slate-950 p-3 text-xs leading-5 text-slate-100">node scripts/license-tool.cjs issue --private-key "C:\SOLIVY-Keys\private.pem" --customer "Customer Legal Name" --company-ids {current.companyId} --perpetual --edition professional --features core,dashboard,accounts,account-movements,parties,purchase,payments,money-in,interest,funding,import,ledger,receivables,reports,bank,backup,gst,commercial-bills,document-settings,settings --out .\customer-perpetual-license.txt</pre><p className="mt-3 font-bold">Configure on your local PC</p><p>Add to <code>.env.local</code>: <code>SOLIVY_LICENSE_ENFORCEMENT=required</code> and <code>SOLIVY_LICENSE_TOKEN=PASTE_THE_FULL_TOKEN</code>. For multiple organizations use <code>SOLIVY_LICENSES_JSON</code> as a JSON map keyed by company ID, for example <code>{`{"1":"TOKEN_FOR_ID_1","2":"TOKEN_FOR_ID_2"}`}</code>. Restart the dev server after changing environment variables.</p><p className="mt-3 font-bold">Configure on Vercel</p><p>In Project → Settings → Environment Variables, set <code>SOLIVY_LICENSE_ENFORCEMENT=required</code> and <code>SOLIVY_LICENSES_JSON</code> with each company ID mapped to its signed token, then redeploy. Existing customers need valid tokens before enforcement is enabled.</p><p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950"><strong>Important:</strong> A perpetual license has no expiry and an offline token cannot be remotely revoked. For online Vercel, removing/replacing the token and redeploying can revoke access. Wildcard company IDs (<code>*</code>) are only for a dedicated single-customer installation, never a shared server. Module display is not proof of API enforcement; test protected routes before selling module-limited plans.</p></div>
        </section> : <div className="card p-8 text-center text-sm text-slate-500">Choose an organization to view its license details.</div>}
      </div>}
  </div>;
}

function SummaryCard({ label, value, note, tone = 'slate' }: { label: string; value: number; note: string; tone?: string }) {
  const colors: Record<string, string> = { slate: 'text-slate-950', green: 'text-emerald-700', red: 'text-rose-700', amber: 'text-amber-700' };
  return <div className="card p-4 sm:p-5"><p className="text-xs font-bold text-slate-500">{label}</p><div className={`mt-2 text-3xl font-black ${colors[tone] || colors.slate}`}>{value}</div><p className="mt-1 text-xs text-slate-500">{note}</p></div>;
}
function InfoCell({ label, value, mono = false, capitalize = false }: { label: string; value: string; mono?: boolean; capitalize?: boolean }) {
  return <div className="bg-white p-4 sm:p-5"><p className="text-xs font-semibold text-slate-500">{label}</p><p className={`mt-1 break-all text-sm font-bold text-slate-900 ${mono ? 'font-mono' : ''} ${capitalize ? 'capitalize' : ''}`}>{value}</p></div>;
}
