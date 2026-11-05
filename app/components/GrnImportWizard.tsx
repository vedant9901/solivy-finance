'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normaliseGrnResponse, calculationFor, emptyDraft, type NormalisedGrnResponse } from '../../lib/grn/contract';

/**
 * Import from GRN / PDF — the wizard that runs inside the Add Purchase modal (v2.10.2).
 *
 * It reads a document and hands the values the user accepts back to the purchase form. It never
 * posts: the existing Add Purchase Save remains the only accounting write path, and Cancel leaves
 * nothing behind but the document record the upload created (which can be discarded).
 *
 * The response is normalised at the boundary (lib/grn/contract.ts), so a failed, partial or
 * malformed extraction renders as a failure with its reasons instead of crashing on a missing
 * `draft.calculation`.
 */
type Props = {
  open: boolean;
  companyId: string | number;
  mode: string;
  /** Values currently typed into the purchase form, so the wizard can show what it would change. */
  current: Record<string, any>;
  onClose: () => void;
  onApply: (values: Record<string, any>, meta: { fields: string[]; documentId: number | null }) => void;
};

const LABELS: Record<string, string> = {
  sample_no: 'Sample number', purchase_date: 'Purchase date', truck_number: 'Vehicle number',
  goods_description: 'Description of goods', hsn: 'HSN', invoice_no: 'Invoice number',
  bags_qty: 'Bags / packages', gross_weight: 'Gross weight (kg)', net_weight: 'Net weight (kg)',
  rate: 'Rate per kg', freight: 'Freight', unload_charge: 'Load / unload', driver_rokdi: 'Rokdi',
  other_charges: 'Other charges', moisture: 'Moisture deduction (₹)', discount_pct: 'Discount %',
  quality_deduct_per_mt: 'Quality deduction per MT', party_id: 'Party', broker_party_id: 'Broker',
  // The consignment list's own column names, for the totals cross-check.
  net_weight_kg: 'Net weight (kg)', freight_amount: 'Freight', load_unload: 'Load / unload',
  rokdi: 'Rokdi', deduction_amount: 'Deduction', moisture_percent: 'Moisture %',
  grn_date: 'GRN date', truck_no: 'Truck number', supplier_name: 'Supplier', bags: 'Bags',
};
const ORDER = ['sample_no', 'purchase_date', 'party_id', 'truck_number', 'invoice_no', 'goods_description', 'hsn', 'bags_qty', 'gross_weight', 'net_weight', 'rate', 'freight', 'unload_charge', 'driver_rokdi', 'other_charges', 'discount_pct', 'moisture', 'quality_deduct_per_mt', 'broker_party_id'];
const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const same = (a: any, b: any) => String(a ?? '') === String(b ?? '');
const badge = (c: string) => c === 'high' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : c === 'medium' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-rose-200 bg-rose-50 text-rose-800';

export default function GrnImportWizard({ open, companyId, mode, current, onClose, onApply }: Props) {
  const [step, setStep] = useState<'select' | 'working' | 'review'>('select');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<NormalisedGrnResponse | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, any>>({});
  const [pageShown, setPageShown] = useState(1);
  /** Which consignment row of a list is being reviewed. A list is imported one GRN at a time. */
  const [rowId, setRowId] = useState<string | null>(null);
  /** Fields the user typed over, so recognised values are never confused with entered ones. */
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const busy = step === 'working';

  const reset = useCallback(() => { setStep('select'); setProgress(''); setError(''); setResult(null); setAccepted({}); setValues({}); setPageShown(1); setEdited({}); setShowDiagnostics(false); }, []);
  useEffect(() => { if (!open) reset(); }, [open, reset]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    const t = window.setTimeout(() => { dialogRef.current?.focus(); }, 0);
    return () => { window.removeEventListener('keydown', onKey, true); window.clearTimeout(t); };
  }, [open, busy, onClose]);

  const headers = useMemo(() => ({ 'x-aksh-company-id': String(companyId || ''), 'x-aksh-mode': String(mode || 'LIVE') }), [companyId, mode]);

  const upload = useCallback(async (file: File) => {
    if (busy) return;                                   // one upload at a time: no duplicate submissions
    setStep('working'); setError(''); setResult(null); setProgress(`Reading ${file.name}…`);
    try {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('Choose a PDF file.');
      const body = new FormData(); body.append('file', file); body.append('keep_original', '1');
      setProgress('Reading the pages on this machine — a scanned page takes a few seconds to recognise…');
      const r = await fetch('/api/grn', { method: 'POST', headers, body });
      const normalised = normaliseGrnResponse(await r.json().catch(() => null), r.status);
      setResult(normalised);
      if (!normalised.ok) { setError([normalised.error, ...normalised.problems].filter(Boolean).join(' ') || 'The document could not be read.'); setStep('review'); return; }
      // A consignment list is reviewed row by row, so the fields start on its first row; a single
      // document has no rows and starts on its own draft.
      const next: Record<string, any> = { ...(normalised.grns[0]?.draft.purchase ?? normalised.draft.purchase) };
      const tick: Record<string, boolean> = {};
      for (const k of ORDER) {
        const v = next[k];
        const filled = v !== null && v !== '' && !(typeof v === 'number' && v === 0);
        const typed = current[k] !== undefined && current[k] !== null && current[k] !== '' && !(typeof current[k] === 'number' && current[k] === 0);
        // Ticked by default only where the form is empty. A field already filled in by hand is
        // offered but left unticked, so replacing it is an explicit choice. Nothing is ticked in
        // manual entry, because nothing was read: a field is ticked as it is typed.
        tick[k] = filled && !typed && !normalised.manual_entry;
      }
      setValues(next); setAccepted(tick);
      setRowId(normalised.grns[0]?.id ?? null);
      setPageShown(normalised.grns[0]?.page || normalised.recognised.grn_page || normalised.extraction.viewable_pages[0] || 1);
      setStep('review');
    } catch (e: any) { setError(e?.message || 'The document could not be read.'); setStep('review'); }
    finally { setProgress(''); }
  }, [busy, headers, current]);

  const rows = result?.grns ?? [];
  const activeRow = rows.find((r) => r.id === rowId) ?? null;
  /** The draft under review: the chosen consignment row's own, or the single document's. */
  const draft = activeRow?.draft ?? result?.draft ?? emptyDraft();

  /** Move to another consignment row: its own draft replaces the fields, nothing is combined. */
  const chooseRow = useCallback((id: string) => {
    const row = (result?.grns ?? []).find((r) => r.id === id);
    if (!row) return;
    setRowId(id);
    const next: Record<string, any> = { ...row.draft.purchase };
    const tick: Record<string, boolean> = {};
    for (const k of ORDER) {
      const v = next[k];
      const filled = v !== null && v !== '' && !(typeof v === 'number' && v === 0);
      const typed = current[k] !== undefined && current[k] !== null && current[k] !== '' && !(typeof current[k] === 'number' && current[k] === 0);
      tick[k] = filled && !typed;
    }
    setValues(next); setAccepted(tick);
    setPageShown(row.page || 1);
  }, [result, current]);
  const preview = useMemo(() => calculationFor({ ...current, ...pick(values, accepted) }, draft.calculation.discount_after_quality), [current, values, accepted, draft]);
  const chosen = ORDER.filter((k) => accepted[k]);
  const manual = result?.manual_entry === true;

  /** Typing a value is itself the decision to use it, so the field ticks as it is edited. */
  const editValue = useCallback((k: string, raw: string) => {
    setValues((v) => ({ ...v, [k]: typeof v[k] === 'number' ? (raw === '' ? 0 : Number(raw)) : raw }));
    setAccepted((a) => ({ ...a, [k]: raw !== '' && raw !== '0' }));
    setEdited((e) => (e[k] ? e : { ...e, [k]: true }));
  }, []);

  if (!open) return null;
  const pages = result?.extraction.page_count || 0;
  const GRN_FIELDS = ['sample_no', 'purchase_date', 'bags_qty', 'net_weight', 'freight', 'unload_charge', 'driver_rokdi'];
  const sourceOf = (k: string) => {
    const page = GRN_FIELDS.includes(k) ? result?.recognised.grn_page : result?.recognised.bill_page;
    return page ? `page ${page}` : '';
  };
  /** The parser's own confidence in the value it read, and the text it read it from. */
  const EVIDENCE_KEY: Record<string, string> = {
    sample_no: 'grn.sample_no', purchase_date: 'grn.date', truck_number: 'bill.vehicle_no',
    bags_qty: 'grn.bags', net_weight: 'grn.net_weight_kg', freight: 'grn.freight',
    unload_charge: 'grn.load_unload', driver_rokdi: 'grn.rokdi', invoice_no: 'bill.invoice_no',
    gross_weight: 'bill.line_item', rate: 'bill.line_item', goods_description: 'bill.line_item', hsn: 'bill.line_item',
  };
  const evidenceOf = (k: string) => {
    const e = (draft.evidence as any)?.[EVIDENCE_KEY[k] || ''] as { value?: any; confidence?: string; note?: string } | undefined;
    return e && e.confidence ? { confidence: String(e.confidence), note: String(e.note || e.value || '') } : null;
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center overflow-y-auto bg-slate-950/65 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Import from GRN or PDF" onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[96dvh] w-full max-w-6xl overflow-y-auto overscroll-contain rounded-t-3xl bg-white shadow-2xl outline-none sm:max-h-[92dvh] sm:rounded-3xl">
        <div className="min-w-0 p-4 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Import from GRN / PDF</h2>
              <p className="muted mt-1 text-sm">Read a goods receipt note and its party bill, check what was found, then put the values you accept into the purchase form. Nothing is saved here.</p>
            </div>
            <button type="button" className="secondary btn" onClick={onClose} disabled={busy} data-testid="grn-close">Close</button>
          </div>

          {step === 'select' && (
            <div className="mt-5">
              <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void upload(f); }}
                className={`rounded-2xl border-2 border-dashed p-8 text-center ${dragging ? 'border-teal-500 bg-teal-50' : 'border-slate-300 bg-slate-50'}`}>
                <p className="text-sm font-medium text-slate-800">Drop the PDF here, or choose a file</p>
                <p className="muted mt-1 text-xs">The whole document is read. Pages that are not a GRN or a party bill are reported, not ignored.</p>
                <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="sr-only" data-testid="grn-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.currentTarget.value = ''; }} />
                <button type="button" className="btn mt-4" onClick={() => fileRef.current?.click()} data-testid="grn-choose">Choose PDF</button>
              </div>
              <p className="muted mt-3 text-xs">Up to 15 MB. A password-protected PDF must be saved without protection first. A PDF with a text layer is read exactly, with nothing installed. A scan is recognised automatically on this machine by the OCR engine built into SOLIVY — nothing to install, and the document never leaves the machine. Recognised values are always shown for checking against the page.</p>
            </div>
          )}

          {step === 'working' && (
            <div className="mt-8 text-center" data-testid="grn-progress">
              <div className="mx-auto h-1.5 w-56 overflow-hidden rounded-full bg-slate-200"><div className="h-full w-1/3 animate-pulse rounded-full bg-teal-600" /></div>
              <p className="mt-3 text-sm text-slate-700">{progress || 'Working…'}</p>
            </div>
          )}

          {step === 'review' && (
            <div className="mt-5 space-y-4">
              {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" data-testid="grn-error">{error}</div>}
              {result && (
                <p className="muted text-xs" data-testid="grn-summary">
                  {result.file_name || 'document'} · {pages} page{pages === 1 ? '' : 's'} · read by {result.extraction.source === 'ocr' ? 'recognition' : result.extraction.source === 'text-layer' ? 'the embedded text' : 'eye — the pages are shown here'}
                  {result.recognised.grn_page ? ` · GRN on page ${result.recognised.grn_page}` : ' · no GRN page recognised'}
                  {result.recognised.bill_page ? ` · bill on page ${result.recognised.bill_page}` : ' · no party bill recognised'}
                  {result.recognised.unrecognised_pages.length ? ` · not recognised: page ${result.recognised.unrecognised_pages.join(', ')}` : ''}
                </p>
              )}
              {manual && (
                <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="grn-manual">
                  <p className="font-semibold">These pages are scanned images, so enter the values from the page</p>
                  <p className="mt-1 text-xs">Every page of this document is a photograph of paper with no text behind it, and the OCR engine could not be used on this machine, so nothing could be read automatically — and nothing has been guessed. The pages are shown beside the fields at full scanner resolution: read each value off the page and type it in. The totals calculate as you go, by the same rules the purchase form uses, and only the fields you fill in are carried back. Open “Show how this document was read” for the reason and the fix.</p>
                </div>
              )}
              {result?.extraction.notes.map((n, i) => <p key={i} className="muted text-xs">· {n}</p>)}

              {result && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs" data-testid="grn-diagnostics">
                  <button type="button" className="font-semibold text-slate-700 underline-offset-2 hover:underline" onClick={() => setShowDiagnostics((v) => !v)} data-testid="grn-diagnostics-toggle">
                    {showDiagnostics ? 'Hide' : 'Show'} how this document was read
                  </button>
                  {showDiagnostics && (
                    <div className="mt-2 space-y-1">
                      <p>
                        Engine: <strong>{result.extraction.engine.kind === 'bundled-wasm' ? 'the OCR engine built into SOLIVY' : result.extraction.engine.kind === 'system-tesseract' ? 'Tesseract installed on this machine' : 'none'}</strong>
                        {result.extraction.engine.version ? ` · Tesseract ${result.extraction.engine.version}` : ''}
                        {result.extraction.engine.languages.length ? ` · language data ${result.extraction.engine.languages.join(', ')}` : ''}
                        {` · requested ${result.extraction.engine.language_requested} · psm ${result.extraction.engine.psm}`}
                      </p>
                      {result.extraction.engine.reason ? <p className="text-rose-700">{result.extraction.engine.reason}</p> : null}
                      {result.extraction.engine.path ? <p className="break-all text-slate-500">{result.extraction.engine.path}</p> : null}
                      {/* v2.11.2: when the engine file is present but this build could not load it,
                          every way that was tried is shown — that is the information needed to fix it. */}
                      {result.extraction.engine.load_route ? <p className="text-slate-500">Loaded by {result.extraction.engine.load_route}.</p> : null}
                      {result.extraction.engine.load_attempts.length && !result.extraction.engine.load_route ? (
                        <div data-testid="grn-load-attempts">
                          <p className="text-rose-700">The engine file is present but this build of SOLIVY could not load it. Each way was tried:</p>
                          <ul className="ml-4 list-disc text-rose-700">{result.extraction.engine.load_attempts.map((a, i) => <li key={i} className="break-all">{a}</li>)}</ul>
                        </div>
                      ) : null}
                      <p>{result.extraction.page_count} page(s) · {Math.round(result.extraction.ms / 100) / 10}s in total · nothing was sent off this machine.</p>
                      <table className="mt-1 w-full">
                        <thead className="text-left text-slate-500"><tr><th className="pr-2">Page</th><th className="pr-2">Read by</th><th className="pr-2">Status</th><th className="pr-2">Time</th><th className="pr-2">Characters</th><th>Confidence</th></tr></thead>
                        <tbody>
                          {result.extraction.diagnostics.map((d) => (
                            <tr key={d.page} className="border-t border-slate-200">
                              <td className="pr-2">{d.page}</td>
                              <td className="pr-2">{d.engine === 'bundled-wasm' ? 'built-in OCR' : d.engine === 'system-tesseract' ? 'system Tesseract' : d.engine === 'pdftotext' ? 'pdftotext' : d.engine === 'built-in-reader' ? 'text layer' : '—'}</td>
                              <td className={`pr-2 ${d.status === 'recognised' || d.status === 'text-layer' ? 'text-emerald-700' : 'text-rose-700'}`}>{d.status}{d.detail ? ` — ${d.detail}` : ''}</td>
                              <td className="pr-2">{d.ms ? `${Math.round(d.ms / 100) / 10}s` : '—'}</td>
                              <td className="pr-2">{d.chars || '—'}</td>
                              <td>{d.confidence === null ? '—' : `${d.confidence}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              {result && result.recognised.unrecognised_pages.length > 0 && (
                <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Page {result.recognised.unrecognised_pages.join(', ')} was read but is not a GRN or a party bill in a layout this build knows. Nothing from it is proposed. The parser handles one GRN, one party bill and the first goods line; extra consignments, bills or lines are not imported.</p>
              )}

              {/* v2.12.0: every consignment row of a list, each its own GRN. One is reviewed and
                  taken into the purchase form at a time — a list is never combined into one
                  purchase. */}
              {rows.length > 1 && (
                <div className="space-y-2" data-testid="grn-rows">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-800">{rows.length} consignments on this list — each is a separate purchase</p>
                    <p className="muted text-xs">
                      {result!.counts.rows_detected ?? rows.length} row(s) printed · {result!.counts.rows_extracted ?? rows.length} read · {result!.counts.rows_unresolved ?? 0} unresolved · {result!.counts.documents ?? 0} supplier bill(s) · {result!.counts.goods_lines ?? 0} goods line(s)
                    </p>
                  </div>
                  {result!.totals && result!.totals.differences.length > 0 && (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="grn-totals-check">
                      <p className="font-semibold">The rows do not add up to the printed total</p>
                      <ul className="mt-1 space-y-0.5">
                        {result!.totals.differences.map((d) => (
                          <li key={d.column}>{LABELS[d.column] || d.column}: the rows add to {d.summed.toLocaleString('en-IN')} against {d.printed.toLocaleString('en-IN')} printed ({d.difference > 0 ? '+' : ''}{d.difference.toLocaleString('en-IN')}). Check those rows against the page; nothing has been changed.</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="max-h-72 overflow-auto rounded-xl border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-left uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="p-2">Use</th><th className="p-2">Sample</th><th className="p-2">Date</th><th className="p-2">Truck</th>
                          <th className="p-2">Supplier</th><th className="p-2 text-right">Bags</th><th className="p-2 text-right">Net kg</th>
                          <th className="p-2 text-right">Freight</th><th className="p-2 text-right">Load</th><th className="p-2 text-right">Rokdi</th>
                          <th className="p-2 text-right">Moist %</th><th className="p-2 text-right">Deduction</th><th className="p-2">Bill</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => {
                          const cell = (k: string) => r.cells[k]?.value;
                          const num = (k: string) => (cell(k) === null || cell(k) === undefined ? <span className="text-rose-600">—</span> : Number(cell(k)).toLocaleString('en-IN'));
                          const review = r.warnings.filter((w) => w.severity === 'review');
                          return (
                            <tr key={r.id} className={`border-t border-slate-100 ${r.id === rowId ? 'bg-teal-50' : ''}`} data-row={r.id}>
                              <td className="p-2">
                                <button type="button" className={`rounded-lg border px-2 py-0.5 ${r.id === rowId ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'}`}
                                  onClick={() => chooseRow(r.id)} data-testid={`grn-row-${r.id}`}>{r.id === rowId ? 'Reviewing' : 'Review'}</button>
                              </td>
                              <td className="p-2 font-medium">{String(cell('sample_no') ?? '—')}</td>
                              <td className="p-2">{String(cell('grn_date') ?? '—')}</td>
                              <td className="p-2">{String(cell('truck_no') ?? '—')}</td>
                              <td className="p-2">{String(cell('supplier_name') ?? '—')}{r.cells.supplier_name?.confidence === 'low' ? <span className="ml-1 text-amber-700">?</span> : null}</td>
                              <td className="p-2 text-right">{num('bags')}</td>
                              <td className="p-2 text-right">{num('net_weight_kg')}</td>
                              <td className="p-2 text-right">{num('freight_amount')}</td>
                              <td className="p-2 text-right">{num('load_unload')}</td>
                              <td className="p-2 text-right">{num('rokdi')}</td>
                              <td className="p-2 text-right">{num('moisture_percent')}</td>
                              <td className="p-2 text-right">{num('deduction_amount')}</td>
                              <td className="p-2">{r.document_page ? `page ${r.document_page}` : <span className="text-slate-400">none matched</span>}
                                {review.length ? <span className="ml-1 rounded border border-amber-200 bg-amber-50 px-1 text-[10px] uppercase text-amber-900" title={review.map((w) => w.message).join(' ')}>{review.length} to check</span> : null}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {activeRow && activeRow.warnings.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-amber-900" data-testid="grn-row-warnings">
                      {activeRow.warnings.map((w, i) => <li key={i}>· {w.message}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {/* Every page of the upload, and what each was taken to be. */}
              {result && result.page_classifications.length > 1 && (
                <details className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs" data-testid="grn-pages">
                  <summary className="cursor-pointer font-semibold text-slate-700">All {result.page_classifications.length} pages, and the supplier bills read from them</summary>
                  <table className="mt-2 w-full">
                    <thead className="text-left text-slate-500"><tr><th className="pr-2">Page</th><th className="pr-2">Taken to be</th><th className="pr-2">Supplier</th><th className="pr-2">Invoice</th><th className="pr-2">Goods lines</th><th>Rate</th></tr></thead>
                    <tbody>
                      {result.page_classifications.map((pc) => {
                        const doc = result.documents.find((x) => x.page === pc.page);
                        const line = doc?.lines[0];
                        return (
                          <tr key={pc.page} className="border-t border-slate-100">
                            <td className="pr-2">{pc.page}</td>
                            <td className="pr-2">{pc.title}{pc.confidence === 'low' ? ' (uncertain)' : ''}</td>
                            <td className="pr-2">{doc?.seller_name || '—'}</td>
                            <td className="pr-2">{doc?.invoice_no || '—'}</td>
                            <td className="pr-2">{doc ? doc.lines.length : '—'}</td>
                            <td>{line ? (line.rate !== null ? `₹${line.rate} per ${line.rate_unit || 'unit'}` : <span className="text-amber-700">not read{line.calculated_check !== null ? ` (amount ÷ quantity = ${line.calculated_check}, a check only)` : ''}</span>) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </details>
              )}

              {result?.ok && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source page</span>
                      {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
                        <button key={p} type="button" onClick={() => setPageShown(p)} className={`rounded-lg border px-2 py-0.5 text-xs ${p === pageShown ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'}`}>{p}</button>
                      ))}
                    </div>
                    {result.document_id && result.original_kept
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img alt={`Page ${pageShown} of the uploaded document`} data-testid="grn-page-image" src={`/api/grn?id=${result.document_id}&page=${pageShown}`} className="mt-2 w-full rounded-xl border border-slate-200" />
                      : <p className="muted mt-2 text-xs">The original was not kept, so the pages cannot be shown.</p>}
                  </div>

                  <div className="space-y-3">
                    {draft.duplicates.length > 0 && (
                      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="grn-duplicates">
                        <p className="font-semibold">Already entered?</p>
                        <ul className="mt-1 space-y-0.5">{draft.duplicates.map((x, i) => <li key={i}>⚠ {x.detail}</li>)}</ul>
                      </div>
                    )}
                    {draft.warnings.length > 0 && (
                      <ul className="space-y-1 text-sm text-slate-700" data-testid="grn-warnings">
                        {draft.warnings.map((w, i) => <li key={i} className={w.severity === 'blocking' ? 'text-rose-700' : ''}>{w.severity === 'blocking' ? '■' : w.severity === 'review' ? '•' : '·'} {w.message}</li>)}
                      </ul>
                    )}

                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                          <tr><th className="p-2">Use</th><th className="p-2">Field</th><th className="p-2">In the form now</th><th className="p-2">From the document</th></tr>
                        </thead>
                        <tbody data-testid="grn-fields">
                          {ORDER.filter((k) => manual || (values[k] !== undefined && values[k] !== null && values[k] !== '' && !(typeof values[k] === 'number' && values[k] === 0))).map((k) => (
                            <tr key={k} className="border-t border-slate-100">
                              <td className="p-2"><input type="checkbox" aria-label={`Use ${LABELS[k] || k}`} data-field={k} checked={Boolean(accepted[k])} onChange={(e) => setAccepted((a) => ({ ...a, [k]: e.target.checked }))} /></td>
                              <td className="p-2">{LABELS[k] || k}{sourceOf(k) ? <span className="muted ml-1 text-xs">({sourceOf(k)})</span> : null}
                                {(() => { const e = evidenceOf(k); return e && !manual ? <span title={e.note} className={`ml-1 rounded border px-1 text-[10px] uppercase ${badge(e.confidence)}`} data-confidence={k}>{e.confidence}</span> : null; })()}
                                {edited[k] ? <span className="ml-1 rounded border border-sky-200 bg-sky-50 px-1 text-[10px] uppercase text-sky-900" data-edited={k}>you edited</span> : null}
                                {!same(current[k] ?? '', '') && !same(current[k], values[k]) ? <span className="ml-1 rounded border border-amber-200 bg-amber-50 px-1 text-[10px] uppercase text-amber-900">replaces what you typed</span> : null}</td>
                              <td className="p-2 text-slate-500">{current[k] === undefined || current[k] === '' || current[k] === null ? <em className="text-slate-400">empty</em> : String(current[k])}</td>
                              <td className="p-2">
                                <input value={String(values[k] ?? '')} onChange={(e) => editValue(k, e.target.value)}
                                  placeholder={manual ? 'type from the page' : undefined}
                                  className="w-full rounded-lg border border-slate-300 px-2 py-1 text-sm" data-value={k} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="grn-calc">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">With the ticked values</span>
                      <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
                        <span>Gross {money(preview.gross_amount)}</span>
                        <span>Deductions {money(preview.total_deduction)}</span>
                        <span className="font-semibold">Net payable {money(preview.net_payable)}</span>
                      </div>
                      <p className="muted mt-1 text-xs">Calculated by the same rules the purchase form uses. Nothing is posted until you save the purchase.</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button type="button" className="secondary btn" onClick={() => { reset(); }} disabled={busy} data-testid="grn-back">Back</button>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="secondary btn" onClick={onClose} disabled={busy}>Cancel</button>
                  <button type="button" className="btn" disabled={!result?.ok || chosen.length === 0} data-testid="grn-apply"
                    onClick={() => onApply(pick(values, accepted), { fields: chosen, documentId: result?.document_id ?? null })}>
                    Use in Purchase Form{activeRow ? ` — ${activeRow.cells.sample_no?.value || activeRow.id}` : ''}{chosen.length ? ` (${chosen.length})` : ''}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function pick(values: Record<string, any>, accepted: Record<string, boolean>) {
  const out: Record<string, any> = {};
  for (const k of Object.keys(values)) if (accepted[k]) out[k] = values[k];
  return out;
}
