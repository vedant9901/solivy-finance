'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { normaliseGrnResponse, calculationFor, blockingReasons, emptyDraft, type NormalisedGrnResponse } from '../../lib/grn/contract';

/**
 * GRN scan → draft purchase (v2.10.0).
 *
 * Upload the document, read what was recognised beside what it will become, correct anything, and
 * save only when you choose to. Nothing is posted until Save: the entry is then created by the
 * ordinary purchase endpoint, with the ordinary rules, from the values shown here.
 */
type Field = { value: any; confidence: 'high' | 'medium' | 'low'; note?: string };
type Warning = { code: string; severity: 'info' | 'review' | 'blocking'; message: string };
type Duplicate = { kind: string; purchase_id?: number; document_id?: number; detail: string };
type Party = { id: number; name: string; gst?: string };
// The endpoint's response is normalised at the boundary (lib/grn/contract.ts), so this screen
// always has a draft, a purchase and a calculation to render — including after a failure.
type Result = NormalisedGrnResponse;

const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const badge = (c: string) => c === 'high' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : c === 'medium' ? 'bg-amber-50 text-amber-900 border-amber-200' : 'bg-rose-50 text-rose-800 border-rose-200';

export default function GrnPage() {
  const [companyId, setCompanyId] = useState(''); const [mode, setMode] = useState('LIVE');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [parties, setParties] = useState<Party[]>([]);
  const [savedId, setSavedId] = useState<number | null>(null);

  useEffect(() => {
    try {
      setCompanyId(sessionStorage.getItem('aksh-company-id') || '');
      setMode(sessionStorage.getItem('aksh-role') === 'TESTER' ? 'TEST' : (sessionStorage.getItem('aksh-login-mode') || 'LIVE'));
    } catch { /* first render on the server */ }
  }, []);
  const headers = useMemo(() => ({ 'x-aksh-company-id': companyId, 'x-aksh-mode': mode }), [companyId, mode]);

  const loadParties = useCallback(async () => {
    if (!companyId) return;
    try {
      const r = await fetch(`/api/data?modules=core,parties&company_id=${companyId}`, { headers, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      setParties(Array.isArray(j.parties) ? j.parties : []);
    } catch { /* the list is a convenience; the draft still works */ }
  }, [companyId, headers]);
  useEffect(() => { void loadParties(); }, [loadParties]);

  const upload = useCallback(async (file: File) => {
    setBusy(true); setNotice(null); setResult(null); setSavedId(null);
    try {
      const body = new FormData(); body.append('file', file); body.append('keep_original', keepOriginal ? '1' : '0');
      const r = await fetch('/api/grn', { method: 'POST', headers, body });
      const j = normaliseGrnResponse(await r.json().catch(() => null), r.status);
      setResult(j); setForm({ ...j.draft.purchase });
      if (!j.ok) { setNotice({ kind: 'error', text: [j.error, ...j.problems].filter(Boolean).join(' ') || 'The document could not be read.' }); return; }
      const blocking = j.draft.warnings.filter((w) => w.severity === 'blocking').length; // normalised: always present
      setNotice({
        kind: j.manual_entry ? 'warning' : blocking ? 'warning' : 'success',
        text: j.manual_entry
          // v2.10.2: no text could be read, but the pages were found and can be shown. Nothing is
          // proposed; the fields below are empty and are filled in from the page.
          ? `${j.extraction.page_count} page(s) were found, but they are scanned images and no recognition engine is installed here, so nothing could be read and nothing has been filled in. Read the values off the page${j.extraction.viewable_pages.length ? ' shown below' : ''} and enter them.`
          : blocking ? `Read ${j.extraction.page_count} page(s). ${blocking} thing(s) must be filled in or chosen before this can be saved.` : `Read ${j.extraction.page_count} page(s). Check the values, then save.`,
      });
    } catch (e: any) { setNotice({ kind: 'error', text: e?.message || 'The upload failed.' }); }
    finally { setBusy(false); }
  }, [headers, keepOriginal]);

  const calc = useMemo(() => calculationFor(form, result?.draft?.calculation?.discount_after_quality ?? 1), [form, result]);
  const blocking = useMemo(() => blockingReasons(form), [form]);

  const createParty = useCallback(async () => {
    const draft = result?.draft?.party?.draft; if (!draft) return;
    const bank = result?.draft?.party?.bank_draft || {};
    const unreadable = [
      !draft.gst && draft.gst_as_read ? `GSTIN read as ${draft.gst_as_read} — it fails its check digit, so it is left blank. Add it by hand after checking the page.` : '',
      !bank.ifsc && bank.ifsc_as_read ? `IFSC read as ${bank.ifsc_as_read} — not a valid IFSC, so it is left blank.` : '',
    ].filter(Boolean).join('\n');
    if (!window.confirm(`Create the party "${draft.name}" from the bill?\n\nGSTIN: ${draft.gst || '— (not filled in)'}\nContact: ${draft.contact || '—'}\nBank: ${bank.bank_name || '—'} ${bank.account_number || ''} ${bank.ifsc || ''}\n${unreadable ? `\n${unreadable}\n` : ''}\nCheck these against the page before saving.`)) return;
    setBusy(true);
    try {
      const { gst_as_read: _g, contact_all: _c, ...partyFields } = draft as any;
      const { ifsc_as_read: _i, ...bankFields } = bank as any;
      const r = await fetch('/api/parties', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...partyFields, ...bankFields, company_id: Number(companyId) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setNotice({ kind: 'error', text: String(j?.error || 'The party could not be created.') }); return; }
      const id = Number(j.id ?? j.partyId ?? 0);
      await loadParties();
      if (id) setForm((f) => ({ ...f, party_id: id }));
      setNotice({ kind: 'success', text: `Party created${id ? ` (#${id})` : ''} and selected.` });
    } catch (e: any) { setNotice({ kind: 'error', text: e?.message || 'The party could not be created.' }); }
    finally { setBusy(false); }
  }, [result, headers, companyId, loadParties]);

  const save = useCallback(async () => {
    if (!result || blocking.length) return;
    if (!window.confirm(`Save this purchase?\n\n${form.sample_no || 'No sample number'} · ${parties.find((p) => p.id === Number(form.party_id))?.name || 'party'} · ${Number(form.net_weight)} kg @ ₹${Number(form.rate)}\nNet payable ${money(calc.net_payable)}\n\nIt is posted with the ordinary purchase rules once you confirm.`)) return;
    setBusy(true);
    try {
      const r = await fetch('/api/purchases', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...form, company_id: Number(companyId) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setNotice({ kind: 'error', text: String(j?.error || 'The purchase was not saved.') }); return; }
      const purchaseId = Number(j.id || 0);
      setSavedId(purchaseId);
      await fetch('/api/grn', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'link', document_id: result.document_id, purchase_id: purchaseId }) });
      setNotice({ kind: 'success', text: `Purchase #${purchaseId} saved and linked to this document. Net payable ${money(j?.calc?.net_payable ?? calc.net_payable)}.` });
    } catch (e: any) { setNotice({ kind: 'error', text: e?.message || 'The purchase was not saved.' }); }
    finally { setBusy(false); }
  }, [result, blocking, form, headers, companyId, calc, parties]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };
  const num = (k: string, label: string, step = '0.01') => (
    <label className="block"><span className="text-xs text-slate-600">{label}</span>
      <input type="number" step={step} value={form[k] ?? ''} onChange={set(k)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
  );

  const draft = result?.draft ?? emptyDraft();
  const grn = result?.parsed?.grn ?? null; const bill = result?.parsed?.bill ?? null;
  const cell = (f: Field | undefined, label: string) => f ? (
    <div className="flex items-baseline justify-between gap-2 border-b border-slate-100 py-1">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-sm text-slate-900">{f.value === null || f.value === '' ? <em className="text-slate-400">not read</em> : String(f.value)}
        <span className={`ml-2 rounded border px-1 text-[10px] uppercase ${badge(f.confidence)}`}>{f.confidence}</span></span>
    </div>) : null;

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold text-slate-900">GRN document → draft purchase</h1>
          <p className="mt-1 text-sm text-slate-600">Upload a GRN with its party bill. Everything read from the pages is a suggestion to check: no entry is posted until you save it here.</p></div>
        <Link href="/" className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700">Back</Link>
      </header>

      {notice && <div className={`rounded-xl border p-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-900' : notice.kind === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice.text}</div>}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept="application/pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} className="text-sm" />
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} /> Keep the original PDF with the entry</label>
          {busy && <span className="text-sm text-slate-500">Working…</span>}
        </div>
        {result && result.problems.length > 0 && <ul className="mt-3 space-y-1 text-xs text-rose-700">{result.problems.map((n, i) => <li key={`p${i}`}>· {n}</li>)}</ul>}
        {result?.extraction?.notes?.length ? <ul className="mt-3 space-y-1 text-xs text-slate-600">{result.extraction.notes.map((n, i) => <li key={i}>· {n}</li>)}</ul> : null}
      </section>

      {result && result.ok && (<>
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Goods receipt note {grn ? '' : '— not recognised'}</h2>
            {grn && <div className="mt-2">
              {cell(grn.sample_no, 'Sample no')}{cell(grn.grn_date, 'GRN date')}{cell(grn.truck_no, 'Truck no')}
              {cell(grn.bags, 'Bags received')}{cell(grn.net_weight_kg, 'Net weight received (kg)')}
              {cell(grn.moisture_percent, 'Moisture %')}{cell(grn.freight_amount, 'Freight')}{cell(grn.load_unload, 'Load / unload')}{cell(grn.rokdi, 'Rokdi')}{cell(grn.party_code, 'Party code')}
            </div>}
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Party bill {bill ? '' : '— not recognised'}</h2>
            {bill && <div className="mt-2">
              {cell(bill.seller_name, 'Seller')}{cell(bill.seller_gstin, 'Seller GSTIN')}{cell(bill.invoice_no, 'Invoice no')}{cell(bill.invoice_date, 'Invoice date')}
              {cell(bill.vehicle_no, 'Vehicle no')}{cell(bill.broker, 'Broker (delivery note)')}
              {bill.items?.[0] && <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-700">{bill.items[0].packages} pkgs · {bill.items[0].description} · HSN {bill.items[0].hsn} · {bill.items[0].quantity} {bill.items[0].quantity_unit} @ {bill.items[0].rate} per {bill.items[0].rate_unit} = {money(bill.items[0].amount)}<br />= {bill.items[0].quantity_kg} kg at {money(bill.items[0].rate_per_kg)} per kg</div>}
              {cell(bill.bank_account, 'Bank account')}{cell(bill.bank_ifsc, 'IFSC')}
            </div>}
            {result.link && <p className="mt-2 text-xs text-slate-600">Match: {result.link.confidence}. {result.link.reasons.join(' ')}</p>}
          </div>
        </section>

        {(draft.warnings.length > 0 || draft.duplicates.length > 0) && (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <h2 className="text-sm font-semibold text-amber-900">Check before saving</h2>
            <ul className="mt-2 space-y-1 text-sm text-amber-900">
              {draft.duplicates.map((x, i) => <li key={`d${i}`}>⚠ {x.detail}</li>)}
              {draft.warnings.filter((w) => w.severity !== 'blocking').map((w, i) => <li key={`w${i}`}>{w.severity === 'review' ? '•' : '·'} {w.message}</li>)}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Draft purchase</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className="text-xs text-slate-600">Party</span>
              <select value={form.party_id || ''} onChange={set('party_id')} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                <option value="">Select a party…</option>
                {parties.map((p) => <option key={p.id} value={p.id}>{p.name}{p.gst ? ` · ${p.gst}` : ''}</option>)}
              </select></label>
            {draft.party?.draft && !form.party_id && <div className="flex items-end"><button type="button" onClick={() => void createParty()} disabled={busy} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">Create “{draft.party.draft.name}” from the bill</button></div>}
            <label className="block"><span className="text-xs text-slate-600">Purchase date</span><input type="date" value={form.purchase_date || ''} onChange={set('purchase_date')} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="block"><span className="text-xs text-slate-600">Sample no</span><input value={form.sample_no || ''} onChange={set('sample_no')} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="block"><span className="text-xs text-slate-600">Vehicle no</span><input value={form.truck_number || ''} onChange={set('truck_number')} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="block"><span className="text-xs text-slate-600">Invoice no</span><input value={form.invoice_no || ''} onChange={set('invoice_no')} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="block"><span className="text-xs text-slate-600">Goods</span><input value={form.goods_description || ''} onChange={set('goods_description')} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            {num('bags_qty', 'Bags', '1')}
            {num('gross_weight', 'Gross weight (kg)')}
            {num('net_weight', 'Net weight (kg)')}
            {num('rate', 'Rate per kg')}
            {num('discount_pct', 'Discount %')}
            {num('freight', 'Freight')}
            {num('unload_charge', 'Load / unload')}
            {num('driver_rokdi', 'Rokdi')}
            {num('other_charges', 'Other charges')}
            {num('moisture', 'Moisture deduction (₹)')}
            {num('quality_deduct_per_mt', 'Quality deduction per MT')}
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Calculation</h3>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div className="flex justify-between"><dt className="text-slate-600">Gross ({Number(form.net_weight || 0)} × {Number(form.rate || 0)})</dt><dd>{money(calc.gross_amount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-600">Discount</dt><dd>{money(calc.discount_amount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-600">Quality deduction</dt><dd>{money(calc.quality_deduct_amount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-600">Total deductions</dt><dd>{money(calc.total_deduction)}</dd></div>
              <div className="flex justify-between font-semibold text-slate-900"><dt>Net payable</dt><dd>{money(calc.net_payable)}</dd></div>
            </dl>
          </div>

          {blocking.length > 0 && <ul className="mt-3 space-y-1 text-sm text-rose-700">{blocking.map((b, i) => <li key={i}>• {b}</li>)}</ul>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void save()} disabled={busy || blocking.length > 0 || savedId !== null} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{savedId ? `Saved as purchase #${savedId}` : 'Save purchase'}</button>
            <span className="text-xs text-slate-500">Document #{result.document_id} · {result.file_name} · read by {result.extraction.source === 'ocr' ? 'recognition' : 'the embedded text'}{result.original_kept ? ' · original kept' : ' · original not kept'}</span>
          </div>
        </section>
      </>)}
    </main>
  );
}
