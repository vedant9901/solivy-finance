'use client';
/** Bill template chooser with live PDF preview (v2.7.0). Saves per user or as the organization default. */
import { useEffect, useMemo, useState } from 'react';

type Tpl = { id: string; name: string; description: string };
const ACCENTS = ['#0f766e', '#1d4ed8', '#7c3aed', '#b45309', '#be123c', '#334155'];

export default function DocumentTemplatesPanel() {
  const [cfg, setCfg] = useState<any>(null); const [docType, setDocType] = useState<'commercial' | 'third-party'>('commercial');
  const [tpl, setTpl] = useState('classic'); const [accent, setAccent] = useState('#0f766e'); const [font, setFont] = useState('helvetica'); const [density, setDensity] = useState('normal');
  const [scope, setScope] = useState<'user' | 'company'>('user'); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => fetch('/api/document-templates', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error); setCfg(j); }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { const p = cfg?.preferences?.[docType]; if (p) { setTpl(p.template_id); setAccent(p.theme?.accent || '#0f766e'); setFont(p.theme?.font || 'helvetica'); setDensity(p.theme?.density || 'normal'); } }, [cfg, docType]);
  const previewUrl = useMemo(() => {
    if (!cfg?.sample_purchase) return '';
    const q = new URLSearchParams({ id: String(cfg.sample_purchase.id), template: tpl, preview: '1', accent, font, density, bill_type: docType === 'third-party' ? 'third-party' : 'purchase' });
    if (docType === 'third-party' && cfg.sample_third_party) q.set('third_party_id', String(cfg.sample_third_party.id));
    return `/api/purchase-bill?${q.toString()}`;
  }, [cfg, tpl, accent, font, density, docType]);
  const save = async () => {
    setBusy(true); setMsg('');
    try { const r = await fetch('/api/document-templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc_type: docType, template_id: tpl, scope, theme: { accent, font, density } }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Save failed'); setMsg(scope === 'company' ? 'Saved as the organization default.' : 'Saved as your personal default.'); load(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  if (!cfg) return <div className="card p-4 text-sm muted">{msg || 'Loading bill templates…'}</div>;
  return (<div className="card grid gap-4 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-bold">Bill templates</h2><p className="muted text-sm">Choose a layout and theme. Every template prints the same figures; only presentation changes.</p></div>
      <div className="flex gap-1 rounded-lg border border-slate-200 p-1 text-xs">{(['commercial', 'third-party'] as const).map((t) => <button key={t} type="button" aria-pressed={docType === t} className={`rounded px-2 py-1 ${docType === t ? 'bg-slate-900 text-white' : ''}`} onClick={() => setDocType(t)}>{t === 'commercial' ? 'Commercial bill' : 'Third-party bill'}</button>)}</div></div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="grid content-start gap-3">
        <div className="grid gap-2" role="radiogroup" aria-label="Template">{cfg.templates.map((t: Tpl) => <label key={t.id} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${tpl === t.id ? 'border-teal-600 bg-teal-50' : 'border-slate-200'}`}><input type="radio" name="tpl" checked={tpl === t.id} onChange={() => setTpl(t.id)} /><span><span className="block font-semibold">{t.name}</span><span className="muted block text-xs">{t.description}</span></span></label>)}</div>
        <fieldset className="grid gap-2 text-sm" disabled={tpl === 'classic'}><legend className="mb-1 text-xs font-semibold">Theme {tpl === 'classic' ? '(not used by Classic)' : ''}</legend>
          <div className="flex flex-wrap items-center gap-2">{ACCENTS.map((a) => <button key={a} type="button" aria-label={`Accent ${a}`} aria-pressed={accent === a} className={`h-7 w-7 rounded-full border-2 ${accent === a ? 'border-slate-900' : 'border-white'}`} style={{ background: a }} onClick={() => setAccent(a)} />)}</div>
          <label className="grid gap-1 text-xs font-semibold">Typeface<select className="rounded border border-slate-200 px-2 py-1" value={font} onChange={(e) => setFont(e.target.value)}><option value="helvetica">Sans (Helvetica)</option><option value="times">Serif (Times)</option><option value="courier">Mono (Courier)</option></select></label>
          <label className="grid gap-1 text-xs font-semibold">Density<select className="rounded border border-slate-200 px-2 py-1" value={density} onChange={(e) => setDensity(e.target.value)}><option value="normal">Comfortable</option><option value="compact">Compact</option></select></label>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1"><input type="radio" name="scope" checked={scope === 'user'} onChange={() => setScope('user')} />Only for me</label>
          {cfg.can_set_company ? <label className="flex items-center gap-1"><input type="radio" name="scope" checked={scope === 'company'} onChange={() => setScope('company')} />Organization default</label> : null}
          <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button>
        </div>
        {msg ? <p role="status" className="text-sm">{msg}</p> : null}
        <p className="muted text-xs">Current: {cfg.preferences[docType].template_id} ({cfg.preferences[docType].scope}). Optional fields (Truck No., bank details, deductions…) are controlled in the settings below and apply to every template.</p>
      </div>
      <div className="min-h-[520px] overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {previewUrl ? <iframe key={previewUrl} title="Bill preview" src={previewUrl} className="h-[720px] w-full" /> : <p className="muted p-6 text-sm">Post a purchase/sample entry to see a live preview.</p>}
      </div>
    </div>
  </div>);
}
