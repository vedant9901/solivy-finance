import { purchaseCalc } from '../utils';

/**
 * The boundary between /api/grn and anything that renders it (v2.10.1).
 *
 * The crash reported at `app/grn/page.tsx` —
 * `Cannot read properties of undefined (reading 'calculation')` — was not a missing `?.`: the
 * screen assumed a response shape the endpoint does not always produce. An extraction that found
 * no readable text answers with `extraction` and an error and NO `draft`, and the screen then read
 * `result.draft.calculation`.
 *
 * Fixing the contract rather than the line: every response is normalised here into one shape that
 * always has a draft, a purchase object with numeric fields, a calculation and the arrays the UI
 * iterates. Nothing is fabricated — an absent value becomes an empty string or 0 and the response
 * is marked `complete: false` with the reason, so the screen shows the failure instead of a
 * plausible-looking draft.
 */
export type NormalisedWarning = { code: string; severity: 'info' | 'review' | 'blocking'; message: string };
export type NormalisedDraft = {
  purchase: Record<string, any>;
  calculation: ReturnType<typeof purchaseCalc> & { discount_after_quality: number };
  party: { matched: boolean; party_id: number | null; party_name: string | null; method: string | null; confidence: string; candidates: any[]; draft: any | null; bank_draft: any | null };
  broker: { name: string | null; party_id: number | null; matched: boolean };
  warnings: NormalisedWarning[];
  duplicates: Array<{ kind: string; purchase_id?: number; document_id?: number; detail: string }>;
  evidence: Record<string, { value: any; confidence: string; note?: string }>;
};
export type NormalisedGrnResponse = {
  ok: boolean;
  complete: boolean;
  problems: string[];
  document_id: number | null;
  file_name: string;
  original_kept: boolean;
  /**
   * True when the document was stored and its pages can be shown, but no text could be read from
   * it — so every value is to be typed in from the page rather than checked against a proposal
   * (v2.10.2). The draft is a complete, empty purchase; nothing is suggested.
   */
  manual_entry: boolean;
  extraction: {
    source: string; page_count: number; notes: string[]; tools: Record<string, any>;
    pages: Array<{ page: number; source: string }>; viewable_pages: number[]; native: boolean;
    /** v2.11.0 diagnostics: which engine read each page, how long it took, how sure it was. */
    diagnostics: Array<{ page: number; status: string; engine: string | null; ms: number; chars: number; confidence: number | null; detail: string | null }>;
    engine: { kind: string; version: string | null; path: string | null; tessdata: string | null; languages: string[]; language_requested: string; psm: number; reason: string | null;
      /** v2.11.2: how the engine file was loaded, and every way that was tried if it could not be. */
      load_route: string | null; load_attempts: string[] };
    ms: number;
  };
  recognised: { grn: boolean; bill: boolean; grn_page: number | null; bill_page: number | null; unrecognised_pages: number[] };
  link: { linked: boolean; confidence: string; reasons: string[] };
  parsed: { grn: any | null; bill: any | null };
  draft: NormalisedDraft;
  /**
   * v2.12.0: the whole document. One entry per consignment row of a list — each its own GRN with
   * its own draft — plus every page's classification, every supplier bill with all its goods
   * lines, the evidence for each link, and the list's printed totals against the sum of the rows.
   * `draft` above remains the first row's, so a single-GRN document behaves exactly as before.
   */
  grns: NormalisedGrnRow[];
  documents: NormalisedDocument[];
  matches: NormalisedMatch[];
  page_classifications: Array<{ page: number; kind: string; title: string; confidence: string; evidence: string[] }>;
  totals: { printed: Record<string, number>; summed: Record<string, number>; differences: Array<{ column: string; printed: number; summed: number; difference: number }>; raw: string } | null;
  counts: Record<string, number>;
  error: string | null;
};
export type NormalisedCell = { value: any; confidence: string; note?: string };
export type NormalisedGrnRow = {
  id: string; page: number; row: number; document_page: number | null;
  cells: Record<string, NormalisedCell>;
  warnings: NormalisedWarning[];
  draft: NormalisedDraft;
  raw: string;
};
export type NormalisedGoodsLine = {
  line: number; description: string | null; hsn: string | null; packages: number | null;
  quantity: number | null; quantity_unit: string | null; rate: number | null; rate_unit: string | null;
  amount: number | null; calculated_check: number | null; warnings: NormalisedWarning[]; raw: string;
};
export type NormalisedDocument = {
  page: number; kind: string; seller_name: string | null; gstin: string | null;
  invoice_no: string | null; invoice_date: string | null; vehicle_no: string | null;
  total_amount: number | null; round_off: number | null; columns: string[];
  lines: NormalisedGoodsLine[]; warnings: NormalisedWarning[];
};
export type NormalisedMatch = {
  document_page: number; grn_id: string | null; score: number; confidence: string;
  evidence: string[]; conflicts: string[]; alternatives: Array<{ grn_id: string; score: number }>;
};

const GRN_ROW_CELLS = ['sample_no', 'grn_date', 'truck_no', 'supplier_name', 'bags', 'net_weight_kg', 'freight_amount', 'load_unload', 'rokdi', 'moisture_percent', 'deduction_amount'] as const;

const warningsOf = (raw: any): NormalisedWarning[] => arr<any>(raw)
  .filter((w) => w && typeof w === 'object' && w.message)
  .map((w) => ({ code: toStr(w.code) || 'WARNING', severity: (['info', 'review', 'blocking'].includes(w.severity) ? w.severity : 'review') as NormalisedWarning['severity'], message: String(w.message) }));

/** The numeric fields `purchaseCalc` reads. Anything missing is 0 — never a guessed figure. */
export const PURCHASE_NUMBERS = ['bags_qty', 'gross_weight', 'net_weight', 'rate', 'freight', 'unload_charge', 'driver_rokdi', 'other_charges', 'moisture', 'discount_pct', 'quality_deduct_per_mt', 'quality_deduct_rate_per_kg', 'gst_rate', 'gst_taxable'] as const;
export const PURCHASE_TEXT = ['sample_no', 'purchase_date', 'truck_number', 'goods_description', 'hsn', 'invoice_no', 'gst_type'] as const;

const toNum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const toStr = (v: any) => (v === null || v === undefined ? '' : String(v));
const arr = <T>(v: any): T[] => (Array.isArray(v) ? v : []);

/** A purchase object `purchaseCalc` and the form can always work with. */
export function normalisePurchase(raw: any): Record<string, any> {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out: Record<string, any> = {};
  for (const k of PURCHASE_TEXT) out[k] = toStr(source[k]);
  for (const k of PURCHASE_NUMBERS) out[k] = toNum(source[k]);
  out.gst_type = out.gst_type || 'NONE';
  out.party_id = source.party_id === null || source.party_id === undefined || source.party_id === '' ? null : Number(source.party_id) || null;
  out.broker_party_id = source.broker_party_id === null || source.broker_party_id === undefined || source.broker_party_id === '' ? null : Number(source.broker_party_id) || null;
  return out;
}

export function calculationFor(purchase: Record<string, any>, discountAfterQuality: any) {
  const rule = Number(discountAfterQuality) === 0 ? 0 : 1;
  return { ...purchaseCalc({ ...purchase, discount_after_quality: rule }), discount_after_quality: rule };
}

/** Normalise one draft — used for the primary draft and for every consignment row's own draft. */
export function normaliseDraft(rawDraft: any): NormalisedDraft {
  const purchase = normalisePurchase(rawDraft?.purchase);
  const party = rawDraft?.party && typeof rawDraft.party === 'object' ? rawDraft.party : null;
  const broker = rawDraft?.broker && typeof rawDraft.broker === 'object' ? rawDraft.broker : null;
  return {
    purchase,
    calculation: calculationFor(purchase, rawDraft?.calculation?.discount_after_quality ?? 1),
    party: {
      matched: party?.matched === true,
      party_id: party?.party_id === null || party?.party_id === undefined ? null : Number(party.party_id) || null,
      party_name: party?.party_name ?? null, method: party?.method ?? null,
      confidence: toStr(party?.confidence) || 'low', candidates: arr<any>(party?.candidates),
      draft: party?.draft ?? null, bank_draft: party?.bank_draft ?? null,
    },
    broker: { name: broker?.name ?? null, party_id: broker?.party_id ?? null, matched: broker?.matched === true },
    warnings: warningsOf(rawDraft?.warnings),
    duplicates: arr<any>(rawDraft?.duplicates).filter((x) => x && typeof x === 'object').map((x) => ({ kind: toStr(x.kind) || 'duplicate', purchase_id: x.purchase_id ? Number(x.purchase_id) : undefined, document_id: x.document_id ? Number(x.document_id) : undefined, detail: toStr(x.detail) })),
    evidence: rawDraft?.evidence && typeof rawDraft.evidence === 'object' ? rawDraft.evidence : {},
  };
}

export function emptyDraft(): NormalisedDraft {
  const purchase = normalisePurchase({});
  return {
    purchase,
    calculation: calculationFor(purchase, 1),
    party: { matched: false, party_id: null, party_name: null, method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null },
    broker: { name: null, party_id: null, matched: false },
    warnings: [], duplicates: [], evidence: {},
  };
}

/**
 * Normalise whatever the endpoint returned. `problems` lists what was missing, so a partial or
 * malformed response is visible rather than silently filled in.
 */
export function normaliseGrnResponse(raw: any, httpStatus = 200): NormalisedGrnResponse {
  const problems: string[] = [];
  const body = raw && typeof raw === 'object' ? raw : {};
  if (!raw || typeof raw !== 'object') problems.push('The server did not return a readable response.');

  const rawDraft = body.draft && typeof body.draft === 'object' ? body.draft : null;
  if (!rawDraft) problems.push('The response carried no draft purchase.');
  const purchase = normalisePurchase(rawDraft?.purchase);
  if (rawDraft && !rawDraft.purchase) problems.push('The draft carried no purchase fields.');

  const rawCalc = rawDraft?.calculation && typeof rawDraft.calculation === 'object' ? rawDraft.calculation : null;
  if (rawDraft && !rawCalc) problems.push('The draft carried no calculation; it was recomputed from the draft values.');
  // Always recomputed locally from the fields on screen: the figure shown must follow the form.
  const calculation = calculationFor(purchase, rawCalc?.discount_after_quality ?? 1);

  const party = rawDraft?.party && typeof rawDraft.party === 'object' ? rawDraft.party : null;
  const broker = rawDraft?.broker && typeof rawDraft.broker === 'object' ? rawDraft.broker : null;
  const extraction = body.extraction && typeof body.extraction === 'object' ? body.extraction : null;
  if (!extraction) problems.push('The response carried no extraction summary.');
  const recognised = body.recognised && typeof body.recognised === 'object' ? body.recognised : null;
  const link = body.link && typeof body.link === 'object' ? body.link : null;

  const error = typeof body.error === 'string' && body.error ? body.error : (httpStatus >= 400 ? `The document could not be read (HTTP ${httpStatus}).` : null);
  const ok = body.ok === true && httpStatus < 400 && Boolean(rawDraft);

  return {
    ok,
    complete: problems.length === 0 && ok,
    problems,
    document_id: Number(body.document_id) || null,
    file_name: toStr(body.file_name),
    original_kept: body.original_kept === true,
    manual_entry: body.manual_entry === true,
    extraction: {
      source: toStr(extraction?.source) || 'none',
      page_count: toNum(extraction?.page_count),
      notes: arr<string>(extraction?.notes).map((n) => String(n)),
      tools: extraction?.tools && typeof extraction.tools === 'object' ? extraction.tools : {},
      pages: arr<any>(extraction?.pages).map((p) => ({ page: toNum(p?.page), source: toStr(p?.source) })),
      viewable_pages: arr<any>(extraction?.viewable_pages).map((p) => toNum(p)).filter((p) => p > 0),
      native: extraction?.native === true,
      diagnostics: arr<any>(extraction?.diagnostics).filter((d) => d && typeof d === 'object').map((d) => ({
        page: toNum(d.page), status: toStr(d.status) || 'not-attempted', engine: d.engine ? toStr(d.engine) : null,
        ms: toNum(d.ms), chars: toNum(d.chars),
        confidence: d.confidence === null || d.confidence === undefined ? null : toNum(d.confidence),
        detail: d.detail ? toStr(d.detail) : null,
      })),
      engine: {
        kind: toStr(extraction?.engine?.kind) || 'none',
        version: extraction?.engine?.version ? toStr(extraction.engine.version) : null,
        path: extraction?.engine?.path ? toStr(extraction.engine.path) : null,
        tessdata: extraction?.engine?.tessdata ? toStr(extraction.engine.tessdata) : null,
        languages: arr<any>(extraction?.engine?.languages).map((l) => toStr(l)).filter(Boolean),
        language_requested: toStr(extraction?.engine?.language_requested) || 'eng',
        psm: toNum(extraction?.engine?.psm),
        reason: extraction?.engine?.reason ? toStr(extraction.engine.reason) : null,
        load_route: extraction?.engine?.load_route ? toStr(extraction.engine.load_route) : null,
        load_attempts: arr<any>(extraction?.engine?.load_attempts).map((a) => toStr(a)).filter(Boolean),
      },
      ms: toNum(extraction?.ms),
    },
    recognised: {
      grn: recognised?.grn === true,
      bill: recognised?.bill === true,
      grn_page: recognised?.grn_page === null || recognised?.grn_page === undefined ? null : toNum(recognised.grn_page) || null,
      bill_page: recognised?.bill_page === null || recognised?.bill_page === undefined ? null : toNum(recognised.bill_page) || null,
      unrecognised_pages: arr<any>(recognised?.unrecognised_pages).map((p) => toNum(p)),
    },
    link: { linked: link?.linked === true, confidence: toStr(link?.confidence) || 'low', reasons: arr<string>(link?.reasons).map((r) => String(r)) },
    parsed: { grn: body.parsed?.grn ?? null, bill: body.parsed?.bill ?? null },
    grns: arr<any>(body.grns).map((g) => ({
      id: toStr(g?.id) || `p${toNum(g?.page)}r${toNum(g?.row)}`,
      page: toNum(g?.page), row: toNum(g?.row),
      document_page: g?.document_page === null || g?.document_page === undefined ? null : toNum(g.document_page) || null,
      cells: GRN_ROW_CELLS.reduce((acc, k) => {
        const cell = g?.[k];
        acc[k] = { value: cell && typeof cell === 'object' ? cell.value ?? null : null, confidence: toStr(cell?.confidence) || 'low', ...(cell?.note ? { note: String(cell.note) } : {}) };
        return acc;
      }, {} as Record<string, NormalisedCell>),
      warnings: warningsOf(g?.warnings),
      draft: normaliseDraft(g?.draft),
      raw: toStr(g?.raw),
    })),
    documents: arr<any>(body.documents).map((d) => ({
      page: toNum(d?.page), kind: toStr(d?.kind) || 'unknown',
      seller_name: d?.bill?.seller_name ?? null, gstin: d?.bill?.gstin ?? null,
      invoice_no: d?.bill?.invoice_no ?? null, invoice_date: d?.bill?.invoice_date ?? null,
      vehicle_no: d?.bill?.vehicle_no ?? null,
      total_amount: d?.bill?.total_amount === null || d?.bill?.total_amount === undefined ? null : toNum(d.bill.total_amount),
      round_off: d?.bill?.round_off === null || d?.bill?.round_off === undefined ? null : toNum(d.bill.round_off),
      columns: arr<any>(d?.bill?.columns).map((c) => toStr(c)),
      lines: arr<any>(d?.bill?.lines).map((l) => ({
        line: toNum(l?.line), description: l?.description ?? null, hsn: l?.hsn ?? null,
        packages: l?.packages ?? null, quantity: l?.quantity ?? null, quantity_unit: l?.quantity_unit ?? null,
        rate: l?.rate ?? null, rate_unit: l?.rate_unit ?? null, amount: l?.amount ?? null,
        calculated_check: l?.calculated_check ?? null, warnings: warningsOf(l?.warnings), raw: toStr(l?.raw),
      })),
      warnings: warningsOf(d?.bill?.warnings),
    })),
    matches: arr<any>(body.matches).map((m) => ({
      document_page: toNum(m?.document_page), grn_id: m?.grn_id ?? null, score: toNum(m?.score),
      confidence: toStr(m?.confidence) || 'low',
      evidence: arr<any>(m?.evidence).map((e) => toStr(e)), conflicts: arr<any>(m?.conflicts).map((e) => toStr(e)),
      alternatives: arr<any>(m?.alternatives).map((a) => ({ grn_id: toStr(a?.grn_id), score: toNum(a?.score) })),
    })),
    page_classifications: arr<any>(body.page_classifications).map((p) => ({
      page: toNum(p?.page), kind: toStr(p?.kind) || 'unknown', title: toStr(p?.title),
      confidence: toStr(p?.confidence) || 'low', evidence: arr<any>(p?.evidence).map((e) => toStr(e)),
    })),
    totals: body.totals && typeof body.totals === 'object' ? {
      printed: body.totals.printed && typeof body.totals.printed === 'object' ? body.totals.printed : {},
      summed: body.totals.summed && typeof body.totals.summed === 'object' ? body.totals.summed : {},
      differences: arr<any>(body.totals.differences).map((x) => ({ column: toStr(x?.column), printed: toNum(x?.printed), summed: toNum(x?.summed), difference: toNum(x?.difference) })),
      raw: toStr(body.totals.raw),
    } : null,
    counts: body.counts && typeof body.counts === 'object' ? body.counts : {},
    draft: {
      purchase,
      calculation,
      party: {
        matched: party?.matched === true,
        party_id: party?.party_id === null || party?.party_id === undefined ? null : Number(party.party_id) || null,
        party_name: party?.party_name ?? null,
        method: party?.method ?? null,
        confidence: toStr(party?.confidence) || 'low',
        candidates: arr<any>(party?.candidates),
        draft: party?.draft ?? null,
        bank_draft: party?.bank_draft ?? null,
      },
      broker: { name: broker?.name ?? null, party_id: broker?.party_id ?? null, matched: broker?.matched === true },
      warnings: arr<any>(rawDraft?.warnings)
        .filter((w) => w && typeof w === 'object' && w.message)
        .map((w) => ({ code: toStr(w.code) || 'WARNING', severity: (['info', 'review', 'blocking'].includes(w.severity) ? w.severity : 'review') as NormalisedWarning['severity'], message: String(w.message) })),
      duplicates: arr<any>(rawDraft?.duplicates).filter((x) => x && typeof x === 'object').map((x) => ({ kind: toStr(x.kind) || 'duplicate', purchase_id: x.purchase_id ? Number(x.purchase_id) : undefined, document_id: x.document_id ? Number(x.document_id) : undefined, detail: toStr(x.detail) })),
      evidence: rawDraft?.evidence && typeof rawDraft.evidence === 'object' ? rawDraft.evidence : {},
    },
    error,
  };
}

/** What still has to be filled in before the purchase form will accept the draft. */
export function blockingReasons(purchase: Record<string, any>): string[] {
  const out: string[] = [];
  if (!purchase.party_id) out.push('Choose or create the party.');
  if (!String(purchase.purchase_date || '').trim()) out.push('Enter the purchase date.');
  if (!Number(purchase.net_weight)) out.push('Enter the net weight.');
  if (!Number(purchase.rate)) out.push('Enter the rate per kg.');
  if (!String(purchase.truck_number || '').trim()) out.push('Enter the vehicle number.');
  return out;
}
