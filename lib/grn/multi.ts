import { toIsoDate, toNumber, looksLikeGrn, looksLikeBill, parseBillPage, type Field } from './parse';

/**
 * Every GRN on the list, and every page of the document (v2.12.0).
 *
 * Until now the pipeline read **one** GRN and **one** supplier bill from a PDF. A real
 * consignment statement is a list: the supplied S M CORPORATION document is thirteen scanned pages
 * whose first page carries twelve consignment rows, each its own GRN with its own sample number,
 * truck, supplier, weight and moisture, followed by eleven supplier bills from three different
 * suppliers and a handwritten receipt. Reading the first row and discarding the rest loses eleven
 * purchases.
 *
 * So this module reads the whole document:
 *
 *  - **every data row of the list is a separate GRN**, in printed order, with its own identity;
 *  - the **Total row is never a GRN** — it is used as a cross-check, by summing the rows and
 *    comparing. That check is what catches a misread cell: on the supplied document the rows sum
 *    to 7,531 bags against a printed total of 7,601, which is reported rather than corrected;
 *  - **every page is classified** and kept, including pages nothing could be made of;
 *  - **documents are linked to rows only on corroborating evidence** — the truck number, the bag
 *    count, the date, the supplier — with the reasons shown and conflicts flagged.
 *
 * Nothing here guesses. A row whose cells wrapped onto the next line, a weight the scanner lost, a
 * figure that disagrees with the printed total: each is carried with its warning so the person
 * reviewing can see it against the page.
 */

export type PageKind = 'grn-list' | 'tax-invoice' | 'bill-of-supply' | 'receipt' | 'unknown';
export type PageClassification = { page: number; kind: PageKind; title: string; confidence: 'high' | 'medium' | 'low'; evidence: string[] };

/** One consignment row of the list: one GRN. */
export type GrnRow = {
  /** Stable within a document: the page and the row's printed position, never an array index. */
  id: string;
  page: number;
  row: number;
  sample_no: Field<string>;
  grn_date: Field<string>;
  truck_no: Field<string>;
  supplier_name: Field<string>;
  bags: Field<number>;
  net_weight_kg: Field<number>;
  freight_amount: Field<number>;
  load_unload: Field<number>;
  rokdi: Field<number>;
  moisture_percent: Field<number>;
  deduction_amount: Field<number>;
  /** The line(s) this row was read from, for checking against the page. */
  raw: string;
  warnings: Array<{ code: string; severity: 'info' | 'review'; message: string }>;
};

export type ListTotals = {
  printed: Partial<Record<'bags' | 'net_weight_kg' | 'freight_amount' | 'load_unload' | 'rokdi' | 'deduction_amount', number>>;
  summed: Record<'bags' | 'net_weight_kg' | 'freight_amount' | 'load_unload' | 'rokdi' | 'deduction_amount', number>;
  differences: Array<{ column: string; printed: number; summed: number; difference: number }>;
  raw: string;
};

export type DocumentMatch = {
  document_page: number;
  grn_id: string | null;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  conflicts: string[];
  /** Other rows that fit about as well; a tie is shown rather than resolved silently. */
  alternatives: Array<{ grn_id: string; score: number }>;
};

export type DocumentSet = {
  pages: PageClassification[];
  grns: GrnRow[];
  documents: Array<{ page: number; kind: PageKind; bill: BillHeader }>;
  matches: DocumentMatch[];
  totals: ListTotals | null;
  counts: {
    pages: number;
    list_pages: number;
    rows_detected: number;
    rows_extracted: number;
    rows_unresolved: number;
    documents: number;
    goods_lines: number;
    unmatched_documents: number;
    unmatched_rows: number;
    pages_unclassified: number;
  };
  /** Pages nothing could be made of, kept visible rather than dropped. */
  unrecognised_pages: number[];
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const lines = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/ /g, ' ')).filter((l) => l.trim().length > 0);
const field = <T,>(value: T | null, confidence: Field<T>['confidence'], source: string, note?: string): Field<T> =>
  ({ value: value as T, confidence, source, ...(note ? { note } : {}) }) as Field<T>;

const SAMPLE = /(\d{3,6}\s*-\s*\d{3,6})/;
const DATE = /(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/;

// ---------------------------------------------------------------------------------------------
// Classifying a page
// ---------------------------------------------------------------------------------------------

/**
 * What a page is. OCR of a scan mangles headings — the supplied document's bill-of-supply pages
 * read variously as "Bill of Supply", "Billof suenly" and "—Bilhof Supply" — so the test is on
 * letters with the noise squeezed out, and several signals are weighed rather than one heading
 * trusted.
 */
export function classifyPage(text: string, page: number): PageClassification {
  const squeezed = text.toLowerCase().replace(/[^a-z0-9%]/g, '');
  const upper = text.toUpperCase();
  const evidence: string[] = [];
  const has = (needle: string, label: string) => { if (squeezed.includes(needle)) { evidence.push(label); return true; } return false; };

  const grnList = has('grnlistreport', 'the heading "GRN List Report"')
    || (has('statementofmaizereceipt', 'the heading "Statement of Maize Receipt"') && /SAMPLE\s*NO/i.test(upper));
  if (grnList) {
    const rows = countDataRows(text);
    evidence.push(`${rows} consignment row(s) before the total`);
    return { page, kind: 'grn-list', title: 'Goods receipt list', confidence: rows > 0 ? 'high' : 'medium', evidence };
  }

  const taxInvoice = has('taxinvoice', 'the heading "Tax Invoice"');
  // "billofsupply" survives most noise; "bilhofsupply"/"billofsuenly" are the forms seen on the
  // supplied scans, so a fuzzy form is accepted too.
  const billOfSupply = has('billofsupply', 'the heading "Bill of Supply"')
    || (/bi[a-z]{0,2}h?of[a-z]{0,2}su[a-z]{0,4}ly/.test(squeezed) ? (evidence.push('a heading reading as "Bill of Supply"'), true) : false);
  const hasInvoiceNo = /INVOICE\s*(NO|M|NC)/i.test(upper) ? (evidence.push('an invoice number'), true) : false;
  const hasHsn = /\bHSN\b/i.test(upper) ? (evidence.push('an HSN column'), true) : false;
  const hasGstin = /\bGSTIN\b/i.test(upper) ? (evidence.push('a GSTIN'), true) : false;

  if (taxInvoice) return { page, kind: 'tax-invoice', title: 'Tax invoice', confidence: hasInvoiceNo || hasHsn ? 'high' : 'medium', evidence };
  if (billOfSupply) return { page, kind: 'bill-of-supply', title: 'Bill of supply', confidence: hasInvoiceNo ? 'high' : 'medium', evidence };
  if (hasInvoiceNo && (hasHsn || hasGstin)) return { page, kind: 'tax-invoice', title: 'Supplier bill', confidence: 'low', evidence };

  // A page with little machine-readable text is usually a handwritten or stamped slip. It is kept
  // and shown, never discarded.
  const letters = squeezed.replace(/[0-9]/g, '').length;
  if (letters < 120) { evidence.push(`only ${letters} readable letters — handwriting or a stamp`); return { page, kind: 'receipt', title: 'Handwritten or stamped slip', confidence: 'low', evidence }; }
  return { page, kind: 'unknown', title: 'Not recognised', confidence: 'low', evidence: evidence.length ? evidence : ['no heading this build recognises'] };
}

// ---------------------------------------------------------------------------------------------
// The list: every row is a GRN
// ---------------------------------------------------------------------------------------------

const isDataRow = (l: string) => SAMPLE.test(l) && DATE.test(l) && !/^\s*total\b/i.test(l);
const isTotalRow = (l: string) => /^\s*total\b/i.test(clean(l));

/** How many consignment rows the page prints, independently of whether each one could be read. */
export function countDataRows(text: string): number {
  let n = 0;
  for (const l of lines(text)) { if (isTotalRow(l)) break; if (isDataRow(l)) n++; }
  return n;
}

/**
 * Every consignment row of a list page, in printed order.
 *
 * The seven measurement columns follow the supplier's name: received bags, net received weight,
 * freight, load/unload, rokdi, moisture % and the deduction. A dense scan does not always keep a
 * row on one line — on the supplied document four rows have their last figures wrapped onto the
 * following line — so a row takes in the lines beneath it until the next row begins. Where the
 * count of figures still does not come to seven, the ones that can be placed are placed (the first
 * four from the front, the last three from the back) and the row carries a warning instead of a
 * guess.
 */
export function parseGrnRows(text: string, page: number): GrnRow[] {
  if (!looksLikeGrn(text)) return [];
  const ls = lines(text);
  const stop = ls.findIndex(isTotalRow);
  const body = stop >= 0 ? ls.slice(0, stop) : ls;

  const rowIndexes = body.map((l, i) => (isDataRow(l) ? i : -1)).filter((i) => i >= 0);
  const out: GrnRow[] = [];

  rowIndexes.forEach((start, n) => {
    const end = n + 1 < rowIndexes.length ? rowIndexes[n + 1] : body.length;
    const rowLine = clean(body[start]);
    // The lines between this row and the next belong to it — a wrapped supplier name, or figures
    // that did not fit — with one exception: a line of nothing but letters immediately above the
    // *next* row is the start of that row's name, not the end of this one. Without that exception
    // every supplier picks up the next consignment's name.
    const hasNext = n + 1 < rowIndexes.length;
    const lastIsNextRowsName = hasNext && end - 1 > start && /^[A-Z][A-Z .&-]*$/.test(clean(body[end - 1])) && !/\d/.test(clean(body[end - 1]));
    const below = body.slice(start + 1, lastIsNextRowsName ? end - 1 : end).map(clean);
    const above = start > 0 && !isDataRow(body[start - 1]) ? clean(body[start - 1]) : '';
    const warnings: GrnRow['warnings'] = [];

    const sample = SAMPLE.exec(rowLine)?.[1]?.replace(/\s/g, '') || null;
    const dateRaw = DATE.exec(rowLine)?.[1] || null;
    const afterDate = dateRaw ? rowLine.slice(rowLine.indexOf(dateRaw) + dateRaw.length) : rowLine;

    // The truck number is the first run of digits after the date; the mill prints only the tail of
    // the registration, which the supplier's bill carries in full.
    const truck = /(?:^|\s|\|)(\d{3,5})(?=\D|$)/.exec(afterDate)?.[1] || null;
    const afterTruck = truck ? afterDate.slice(afterDate.indexOf(truck) + truck.length) : afterDate;

    // The supplier's name: the letters in the row, plus the fragments the column wrapped above and
    // below it. "PITAMBAR" above + "A TRADING" in the row is one name.
    const nameOnRow = clean((afterTruck.match(/[A-Za-z][A-Za-z .&-]{1,}/g) || []).join(' ').replace(/\s+/g, ' '));
    const nameAbove = /^[A-Z][A-Z .&-]{2,}$/.test(above) ? above : '';
    const nameBelow = below.filter((l) => /^[A-Z][A-Z .&-]{0,}$/.test(l.replace(/^\d{1,2}\.\s*/, '')) && !/\d/.test(l.replace(/^\d{1,2}\.\s*/, ''))).map((l) => l.replace(/^\d{1,2}\.\s*/, '')).join(' ');
    let supplier = clean([nameAbove, nameOnRow, nameBelow].filter(Boolean).join(' '));
    // A name broken mid-word ("ENTERPRIS" + "ES") is rejoined; separate words keep their space.
    supplier = supplier.replace(/([A-Z]{3,})\s+([A-Z]{1,3})\b/g, (m, head, tail) => (tail.length <= 2 ? head + tail : m));
    const supplierWrapped = Boolean(nameAbove || nameBelow);

    // The figures: those in the row, then any the row wrapped onto the lines beneath it. A leading
    // "10." on a continuation line is the date column bleeding down, not a figure.
    const figuresIn = (s: string) => (s.replace(/^\s*\d{1,2}\.\s/, ' ').match(/-?\d[\d,]*\.?\d*/g) || [])
      .map((x) => toNumber(x)).filter((x): x is number => x !== null);
    const inRow = figuresIn(afterTruck);
    const continuation: number[] = [];
    for (const l of below) if (!/^[A-Z][A-Z .&-]*$/.test(l.replace(/^\d{1,2}\.\s*/, ''))) continuation.push(...figuresIn(l));
    const all = [...inRow, ...continuation];

    let bags: number | null = null, netWt: number | null = null, freight: number | null = null;
    let load: number | null = null, rokdi: number | null = null, moist: number | null = null, deduction: number | null = null;
    if (all.length === 7) {
      [bags, netWt, freight, load, rokdi, moist, deduction] = all;
    } else if (all.length > 7) {
      // More figures than columns. The first four read left to right from the sample number are
      // reliable; which of the rest is the rokdi, the moisture and the deduction is not, and
      // placing them by position would put a wrong figure in a financial field. They are left
      // empty, with every figure read listed, for entry from the page.
      [bags, netWt, freight, load] = all.slice(0, 4);
      warnings.push({ code: 'ROW_EXTRA_FIGURES', severity: 'review', message: `This row reads ${all.length} figures where the list prints seven columns (${all.join(', ')}), so the rokdi, moisture and deduction could not be placed with confidence and are left empty. Enter them from the page.` });
    } else {
      [bags, netWt, freight, load, rokdi, moist, deduction] = [...all, ...Array(7 - all.length).fill(null)] as any;
      warnings.push({ code: 'ROW_MISSING_FIGURES', severity: 'review', message: `Only ${all.length} of the seven figures could be read on this row (${all.join(', ') || 'none'}); the rest are empty and must be entered from the page.` });
    }
    if (continuation.length) warnings.push({ code: 'ROW_WRAPPED', severity: 'info', message: 'Some of this row is printed on the line beneath it; those figures were read from there.' });
    // A figure the scanner ran into a letter ("s0080" for 30080) is not a figure that can be
    // trusted, however well it parses.
    const smudged = (afterTruck.match(/[A-Za-z]\d{2,}|\d{2,}[A-Za-z]/g) || []).filter((t) => !/^[A-Za-z]$/.test(t));
    if (smudged.length) warnings.push({ code: 'FIGURE_TOUCHING_LETTER', severity: 'review', message: `${smudged.join(', ')} was read with a letter against the digits, so that figure may be wrong — check it against the page.` });

    // A moisture reading outside what a percentage can be is a misread, not a measurement.
    if (moist !== null && (moist < 0 || moist > 60)) {
      warnings.push({ code: 'MOISTURE_IMPLAUSIBLE', severity: 'review', message: `The moisture column reads ${moist}, which is not a plausible percentage; check it against the page.` });
      moist = null;
    }
    if (netWt !== null && bags !== null && bags > 0) {
      const perBag = netWt / bags;
      if (perBag < 20 || perBag > 100) warnings.push({ code: 'WEIGHT_PER_BAG_ODD', severity: 'review', message: `${netWt} kg over ${bags} bags is ${perBag.toFixed(1)} kg a bag, which is outside the usual range; one of the two may be misread.` });
    }
    if (!sample) warnings.push({ code: 'SAMPLE_MISSING', severity: 'review', message: 'No sample number could be read on this row.' });

    const raw = [above, rowLine, ...below].filter(Boolean).join(' / ');
    const conf = (v: any): Field<any>['confidence'] => (v === null || v === undefined ? 'low' : all.length === 7 ? 'medium' : 'low');
    out.push({
      id: `p${page}r${n + 1}`,
      page,
      row: n + 1,
      sample_no: field(sample, sample ? 'high' : 'low', rowLine),
      grn_date: field(toIsoDate(dateRaw), toIsoDate(dateRaw) ? 'high' : 'low', rowLine, dateRaw ? `printed as ${dateRaw}` : undefined),
      truck_no: field(truck, truck ? 'medium' : 'low', rowLine, truck ? 'The list prints only part of the registration; the supplier\'s bill carries it in full.' : undefined),
      supplier_name: field(supplier || null, supplier ? (supplierWrapped ? 'low' : 'medium') : 'low', rowLine,
        supplierWrapped ? 'The name is printed wrapped inside its column and was reassembled from the lines around the row. Check it against the page.' : undefined),
      bags: field(bags, conf(bags), rowLine),
      net_weight_kg: field(netWt, conf(netWt), rowLine, 'Net weight received, as weighed by the buyer.'),
      freight_amount: field(freight, conf(freight), rowLine),
      load_unload: field(load, conf(load), rowLine),
      rokdi: field(rokdi, conf(rokdi), rowLine),
      moisture_percent: field(moist, conf(moist), rowLine, 'A percentage, not an amount.'),
      deduction_amount: field(deduction, conf(deduction), rowLine, 'The deduction printed on the list, in rupees.'),
      raw,
      warnings,
    });
  });

  return out;
}

/**
 * The printed Total row against the sum of the rows. The list totals six of its columns (moisture
 * is a percentage and is not totalled), so each is compared and any difference reported. This is
 * the check that catches a misread cell — and it only ever reports: a printed total never
 * overwrites a row.
 */
export function listTotals(text: string, rows: GrnRow[]): ListTotals | null {
  const ls = lines(text);
  const totalLine = ls.find(isTotalRow);
  const columns = ['bags', 'net_weight_kg', 'freight_amount', 'load_unload', 'rokdi', 'deduction_amount'] as const;
  const summed = columns.reduce((acc, c) => {
    acc[c] = rows.reduce((sum, r) => sum + (Number((r as any)[c].value) || 0), 0);
    return acc;
  }, {} as Record<typeof columns[number], number>);
  if (!totalLine) return { printed: {}, summed, differences: [], raw: '' };

  const figures = (clean(totalLine).replace(/^total\s*/i, '').match(/-?\d[\d,]*\.?\d*/g) || [])
    .map((x) => toNumber(x)).filter((x): x is number => x !== null);
  const printed: ListTotals['printed'] = {};
  // The printed total carries the six totalled columns in their printed order.
  columns.forEach((c, i) => { if (i < figures.length) printed[c] = figures[i]; });
  const differences = columns
    .filter((c) => printed[c] !== undefined)
    .map((c) => ({ column: c, printed: printed[c]!, summed: summed[c], difference: Math.round((summed[c] - printed[c]!) * 100) / 100 }))
    .filter((d) => Math.abs(d.difference) > 0.5);
  return { printed, summed, differences, raw: clean(totalLine) };
}

// ---------------------------------------------------------------------------------------------
// Linking documents to rows
// ---------------------------------------------------------------------------------------------

const digitsOf = (s: string | null | undefined) => String(s || '').replace(/\D/g, '');
const wordsOf = (s: string | null | undefined) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);

/**
 * Which consignment row a supplier's bill belongs to, decided on corroborating evidence and never
 * on one weak signal: the vehicle number (the list prints its tail, the bill the whole of it), the
 * bag count, the supplier's name and the dates being within a few days. A tie is reported as a tie.
 */
export function matchDocuments(rows: GrnRow[], documents: Array<{ page: number; kind: PageKind; bill: BillHeader }>): DocumentMatch[] {
  return documents.map(({ page, bill }) => {
    const scored = rows.map((row) => {
      const evidence: string[] = []; const conflicts: string[] = []; let score = 0;

      const listTail = digitsOf(row.truck_no.value);
      const billDigits = digitsOf(bill.vehicle_no);
      if (listTail && billDigits) {
        if (billDigits.endsWith(listTail) || listTail.endsWith(billDigits)) { score += 50; evidence.push(`the vehicle number ends ${listTail}, as the bill's ${bill.vehicle_no} does`); }
        else { score -= 35; conflicts.push(`the list's vehicle ${listTail} does not match the bill's ${bill.vehicle_no}`); }
      }

      const bags = Number(row.bags.value);
      const packages = Number(bill.lines?.[0]?.packages);
      if (bags && packages) {
        if (bags === packages) { score += 30; evidence.push(`${bags} bags on both`); }
        else { score -= 15; conflicts.push(`${bags} bags on the list against ${packages} on the bill`); }
      }

      const rowWords = wordsOf(row.supplier_name.value);
      const billWords = wordsOf(bill.seller_name);
      const shared = rowWords.filter((w) => billWords.some((b) => b.startsWith(w.slice(0, 5)) || w.startsWith(b.slice(0, 5))));
      if (shared.length) { score += 20; evidence.push(`the supplier's name shares "${shared.join(' ')}"`); }
      else if (rowWords.length && billWords.length) { score -= 10; conflicts.push(`"${row.supplier_name.value}" on the list against "${bill.seller_name}" on the bill`); }

      const rowDate = row.grn_date.value ? Date.parse(String(row.grn_date.value)) : NaN;
      const billDate = bill.invoice_date ? Date.parse(String(bill.invoice_date)) : NaN;
      if (Number.isFinite(rowDate) && Number.isFinite(billDate)) {
        const days = Math.abs(rowDate - billDate) / 86_400_000;
        if (days <= 7) { score += 10; evidence.push(`the dates are ${Math.round(days)} day(s) apart`); }
        else { score -= 10; conflicts.push(`the dates are ${Math.round(days)} days apart`); }
      }

      return { row, score, evidence, conflicts };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    // A link needs real corroboration: the vehicle alone, or two weaker signals together.
    const MIN = 50;
    if (!best || best.score < MIN) {
      return { document_page: page, grn_id: null, score: best?.score ?? 0, confidence: 'low' as const, evidence: best?.evidence ?? [], conflicts: best?.conflicts ?? [], alternatives: [] };
    }
    const ties = scored.filter((s) => s !== best && best.score - s.score <= 10).map((s) => ({ grn_id: s.row.id, score: s.score }));
    return {
      document_page: page,
      grn_id: best.row.id,
      score: best.score,
      confidence: ties.length ? 'low' : best.score >= 80 ? 'high' : 'medium',
      evidence: best.evidence,
      conflicts: ties.length ? [...best.conflicts, `${ties.length} other consignment row(s) fit this bill about as well; confirm which one it belongs to.`] : best.conflicts,
      alternatives: ties,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------------------------

/** Read a whole upload: classify every page, take every row, every bill, and link them. */
export function parseDocumentSet(pages: Array<{ page: number; text: string }>): DocumentSet {
  const classifications = pages.map((p) => classifyPage(p.text, p.page));
  const grns: GrnRow[] = [];
  const documents: DocumentSet['documents'] = [];
  const unrecognised: number[] = [];
  let detected = 0;
  let totals: ListTotals | null = null;

  for (const p of pages) {
    const kind = classifications.find((c) => c.page === p.page)!.kind;
    if (kind === 'grn-list') {
      detected += countDataRows(p.text);
      const rows = parseGrnRows(p.text, p.page);
      grns.push(...rows);
      // The first list page's totals are the ones compared; a second list page gets its own check.
      const t = listTotals(p.text, rows);
      if (t && !totals) totals = t;
      continue;
    }
    if (kind === 'tax-invoice' || kind === 'bill-of-supply') {
      const bill = bestBill(p.text, p.page);
      // A page classified as a bill is kept as one even when little could be read from it: it is
      // shown with its warnings rather than dropped out of the document.
      documents.push({ page: p.page, kind, bill });
      continue;
    }
    unrecognised.push(p.page);
  }

  const matches = matchDocuments(grns, documents);
  const matchedRowIds = new Set(matches.map((m) => m.grn_id).filter(Boolean) as string[]);
  // A row that could not be read at all — no sample number and no weight — is unresolved: it is
  // still shown, and it is counted so that extracted + unresolved equals the rows on the page.
  const unresolved = grns.filter((g) => !g.sample_no.value && !g.net_weight_kg.value).length;

  return {
    pages: classifications,
    grns,
    documents,
    matches,
    totals,
    counts: {
      pages: pages.length,
      list_pages: classifications.filter((c) => c.kind === 'grn-list').length,
      rows_detected: detected,
      rows_extracted: grns.length - unresolved,
      rows_unresolved: unresolved,
      documents: documents.length,
      goods_lines: documents.reduce((n, d) => n + (d.bill.lines?.length || 0), 0),
      unmatched_documents: matches.filter((m) => !m.grn_id).length,
      unmatched_rows: grns.filter((g) => !matchedRowIds.has(g.id)).length,
      pages_unclassified: classifications.filter((c) => c.kind === 'unknown').length,
    },
    unrecognised_pages: unrecognised,
  };
}

/** The bill, if any, that a given row was linked to. */
export function documentFor(set: DocumentSet, grnId: string): { page: number; kind: PageKind; bill: BillHeader } | null {
  const match = set.matches.find((m) => m.grn_id === grnId);
  if (!match) return null;
  return set.documents.find((d) => d.page === match.document_page) || null;
}

export { looksLikeBill };

// ---------------------------------------------------------------------------------------------
// Goods lines, from whatever column order the bill prints
// ---------------------------------------------------------------------------------------------

export type GoodsLine = {
  line: number;
  description: string | null;
  hsn: string | null;
  packages: number | null;
  quantity: number | null;
  quantity_unit: string | null;
  /** The rate **as printed**. Null when the column is absent or the cell could not be read. */
  rate: number | null;
  rate_unit: string | null;
  amount: number | null;
  /** amount ÷ quantity. A cross-check only — never used as the rate. */
  calculated_check: number | null;
  raw: string;
  warnings: Array<{ code: string; severity: 'info' | 'review'; message: string }>;
};
export type BillHeader = {
  page: number;
  seller_name: string | null;
  gstin: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  vehicle_no: string | null;
  broker: string | null;
  total_amount: number | null;
  round_off: number | null;
  tax_amount: number | null;
  columns: string[];
  lines: GoodsLine[];
  warnings: Array<{ code: string; severity: 'info' | 'review'; message: string }>;
};

/** The column each header word stands for. The order comes from the page, never from this list. */
const COLUMN_WORDS: Array<[RegExp, GoodsColumn]> = [
  [/^(s\.?no|sno|sl|ik|no)\.?$/i, 'line'],
  [/^(desc|discription|description)/i, 'description'],
  [/^(hsn|hen|hsn\/sac|hen\/sac)/i, 'hsn'],
  [/^(bags|katte|packages|pkgs)$/i, 'packages'],
  [/^(no\.of|noof)$/i, 'packages'],
  [/^(uom|unit)$/i, 'quantity_unit'],
  [/^(qty|quantity|wieght|weight|net)$/i, 'quantity'],
  [/^rate$/i, 'rate'],
  [/^per\]?$/i, 'rate_unit'],
  [/^amount\]?$/i, 'amount'],
  [/^(cgst|sgst|igst)$/i, 'tax'],
];
type GoodsColumn = 'line' | 'description' | 'hsn' | 'packages' | 'quantity' | 'quantity_unit' | 'rate' | 'rate_unit' | 'amount' | 'tax';

/**
 * The numeric columns a bill prints, in the order it prints them, taken from its own header row.
 *
 * Two layouts appear in the supplied document and they do not agree: a tax invoice heads its
 * columns `NO.of UOM NET rate per Amount CGST SGST IGST`, while a Tally bill of supply heads them
 * `HSN/SAC Quantity Rate per Amount` — and on these scans the Tally rate column comes back empty,
 * because a broker's handwriting sits across it. Reading the order off the page means neither
 * layout has to be hardcoded, and a column the page does not print is simply absent.
 */
function goodsColumns(headerLine: string): GoodsColumn[] {
  const out: GoodsColumn[] = [];
  for (const token of clean(headerLine).split(/[\s|]+/)) {
    const t = token.replace(/[^A-Za-z0-9./]/g, '');
    if (!t) continue;
    for (const [re, col] of COLUMN_WORDS) if (re.test(t)) { if (!out.includes(col) || col === 'tax') out.push(col); break; }
  }
  return out;
}

const NUMERIC_COLUMNS: GoodsColumn[] = ['hsn', 'packages', 'quantity', 'rate', 'amount', 'tax'];

/**
 * Read a supplier bill: its header fields and **every** goods line, with the rate kept distinct
 * from the amount and from the quantity.
 *
 * Where the rate is not printed, or could not be read, it stays null and `calculated_check` holds
 * amount ÷ quantity instead — labelled as a check, never promoted to the rate. Deriving a rate
 * from the amount and calling it the bill's rate would be inventing a figure.
 */
export function parseSupplierBill(text: string, page: number): BillHeader {
  const ls = lines(text);
  const all = clean(ls.join(' '));
  const warnings: BillHeader['warnings'] = [];

  // The seller: the first line that looks like a trading name, skipping the headings, the
  // jurisdiction note and the "to"/consignee blocks.
  const sellerLine = ls.slice(0, 10).map(clean).find((l) =>
    /[A-Z]{3,}/.test(l)
    && !/tax\s*invoice|bill\s*of|subject to|juri[sc]diction|gstin|^ad\b|^address|contact|^to\b|consignee|buyer|^\W*$/i.test(l)
    && !/^[^A-Za-z]*$/.test(l)
    && l.replace(/[^A-Za-z]/g, '').length >= 6);
  const seller = sellerLine ? clean(sellerLine.replace(/^[^A-Za-z]+/, '').replace(/\s*[,|].*$/, '')) : null;

  const gstin = (all.match(/\b\d{2}\s?[A-Z]{5}\s?\d{4}\s?[A-Z]\s?[0-9A-Z]\s?[A-Z0-9]\s?[0-9A-Z]\b/) || [null])[0]?.replace(/\s/g, '') || null;
  // "invoice no", and the forms OCR makes of it: "invoice nc", "invoice m", "LAVOICE NO".
  // "invoice no", and the forms OCR makes of it. The value must carry a digit: on these scans the
  // heading "TAX INVOICE subject to …" otherwise captures the next word as the number.
  const invoiceNo = ([...all.matchAll(/(?:inv|lav)oice\s*(?:no|nc|n|m)?\s*\.?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9/\-]{0,20})/gi)]
    .map((m) => m[1])
    .find((v) => /\d/.test(v) && !/^(dated?|no|nc)$/i.test(v)) || null);
  const dateRaw = /\b(\d{1,2}[-./]\d{1,2}[-./]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{2,4})\b/.exec(all)?.[1] || null;
  const vehicle = (/(?:vehicle|motor\s*vehicle)\s*(?:no|number)?\s*\.?\s*[:\-]?\s*([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{3,4})/i.exec(all)?.[1] || '').replace(/\s/g, '') || null;
  const broker = /broker\s*[-:]?\s*([A-Z][A-Z .&-]{3,40})/i.exec(all)?.[1]?.trim() || null;
  const roundOff = toNumber(/round\s*off\s*[-:=]?\s*(-?[\d,]*\.?\d+)/i.exec(all)?.[1] || null);
  const totals = [...all.matchAll(/total\s*amount\s*[=:]?\s*(?:\d\s)?([\d,]+\.?\d*)/gi)].map((m) => toNumber(m[1])).filter((x): x is number => x !== null);
  const taxAmount = /NIL|0\.00\s*0\.00/.test(all) ? 0 : null;

  // The goods table's header line, then every line beneath it that begins with a line number.
  const headerIndex = ls.findIndex((l) => { const c = goodsColumns(l); return c.includes('amount') && (c.includes('quantity') || c.includes('hsn')); });
  const columns = headerIndex >= 0 ? goodsColumns(ls[headerIndex]) : [];
  const numeric = columns.filter((c) => NUMERIC_COLUMNS.includes(c));
  const goods: GoodsLine[] = [];

  if (headerIndex >= 0) {
    // An HSN printed on its own line below the table belongs to the goods line above it.
    // An HSN printed on its own line below the table, or beside its label, belongs to the line
    // above it. Six to eight digits, which is what an HSN is.
    const loose = (ls.slice(headerIndex).map(clean).map((l) => /(?:^|\s)(\d{6,8})(?:\s|$)/.exec(l)?.[1]).find(Boolean)
      || /hsn[^0-9]{0,40}(\d{6,8})/i.exec(all)?.[1] || null);
    for (let i = headerIndex + 1; i < ls.length; i++) {
      const line = clean(ls[i]);
      if (/^(total|bank|amount in words|terms|for[-\s])/i.test(line)) break;
      // A scan puts table rules and stray marks in front of the line number, so a little leading
      // noise is allowed before it.
      const lineNo = /^[^A-Za-z0-9]{0,3}(\d{1,2})\s*[|.)]?\s*[^A-Za-z0-9]{0,3}\s*(?=[A-Za-z])/.exec(line);
      if (!lineNo) continue;
      const rest = line.slice(lineNo[0].length);
      const description = (rest.match(/^[A-Za-z][A-Za-z ]{1,30}/) || [null])[0]?.trim() || null;
      const figures = (rest.match(/-?\d[\d,]*\.?\d*/g) || []).map((x) => toNumber(x)).filter((x): x is number => x !== null);
      const unit = (rest.match(/\b(QTL|QTLS|QUINTAL|KG|KGS|MT|BAG|BAGS|KATTE)\b\.?/i) || [null])[0]?.replace(/\.$/, '') || null;

      const cell: Partial<Record<GoodsColumn, number>> = {};
      const lineWarnings: GoodsLine['warnings'] = [];
      // Figures are placed in the printed columns only when there are exactly as many as the
      // header prints. One missing or one extra shifts every column after it, which on a bill
      // means a rate in the amount or a quantity in the rate — a wrong financial figure. So when
      // the counts disagree nothing is placed: the figures read are listed and entered by hand.
      // A blank or unread tax column at the *end* of the row shifts nothing before it, and on
      // these bills the CGST/SGST/IGST cells are routinely left empty. Those trailing tax columns
      // are dropped from the expectation before the counts are compared; the money columns are
      // never dropped.
      let expected = [...numeric];
      const taxColumns = numeric.filter((c) => c === 'tax').length;
      while (expected.length > figures.length && expected[expected.length - 1] === 'tax') expected.pop();
      // The mirror case: a tax cell read as two tokens ("0.00 0.00" for one cell) leaves more
      // figures than columns. Where the surplus is no larger than the number of tax columns, the
      // money columns still line up from the front and the surplus is trailing noise.
      if (figures.length > expected.length && figures.length - expected.length <= taxColumns) {
        figures.length = expected.length;
        lineWarnings.push({ code: 'LINE_TAX_CELLS_SPLIT', severity: 'info', message: 'A tax cell at the end of this line was read as more than one figure; the quantity, rate and amount were read from the columns before them.' });
      }
      if (figures.length === expected.length) {
        expected.forEach((c, n) => { cell[c] = figures[n]; });
        if (expected.length < numeric.length) lineWarnings.push({ code: 'LINE_TAX_CELLS_BLANK', severity: 'info', message: `${numeric.length - expected.length} tax cell(s) at the end of this line were blank or unreadable; the quantity, rate and amount were read from the columns before them.` });
      } else {
        lineWarnings.push({ code: 'LINE_COLUMN_COUNT', severity: 'review', message: `This line reads ${figures.length} figure(s) — ${figures.join(', ') || 'none'} — where its header prints ${numeric.length} numeric column(s) (${numeric.join(', ')}). They could not be placed without risking a figure in the wrong column, so the quantity, rate and amount are left empty. Enter them from the page.` });
      }
      const quantity = cell.quantity ?? null;
      const amount = cell.amount ?? null;
      const rate = cell.rate ?? null;
      const check = quantity && amount ? Math.round((amount / quantity) * 100) / 100 : null;

      if (columns.includes('rate') && rate === null) {
        lineWarnings.push({ code: 'RATE_NOT_READ', severity: 'review', message: `The bill prints a rate column but its value could not be read on this line${check !== null ? ` — ${amount} over ${quantity} works out at ${check}, which is a cross-check only and has not been used as the rate` : ''}. Enter the rate from the page.` });
      } else if (!columns.includes('rate')) {
        lineWarnings.push({ code: 'RATE_COLUMN_ABSENT', severity: 'review', message: `No rate column was found in this bill's table${check !== null ? ` — ${amount} over ${quantity} works out at ${check}, as a cross-check only` : ''}. Enter the rate from the page.` });
      } else if (rate !== null && quantity && amount) {
        const expected = rate * quantity;
        if (Math.abs(expected - amount) > Math.max(1, amount * 0.01)) {
          lineWarnings.push({ code: 'LINE_DOES_NOT_MULTIPLY', severity: 'review', message: `${quantity} × ${rate} is ${Math.round(expected * 100) / 100}, but the line reads ${amount}. Nothing was changed; check the page.` });
        }
      }

      goods.push({
        line: Number(lineNo[1]),
        description,
        hsn: cell.hsn ? String(cell.hsn) : (loose || null),
        packages: cell.packages ?? null,
        quantity,
        quantity_unit: unit,
        rate,
        rate_unit: columns.includes('rate_unit') ? unit : null,
        amount,
        calculated_check: check,
        raw: line,
        warnings: lineWarnings,
      });
    }
  }

  if (headerIndex < 0) warnings.push({ code: 'NO_GOODS_TABLE', severity: 'review', message: 'No goods table header could be found on this page, so no line could be read from it.' });
  else if (!goods.length) warnings.push({ code: 'NO_GOODS_LINES', severity: 'review', message: `The goods table header was found (${columns.join(', ')}) but no line beneath it could be read.` });

  const sumOfLines = goods.reduce((n, g) => n + (g.amount || 0), 0);
  const printedTotal = totals.length ? Math.max(...totals) : null;
  if (printedTotal && sumOfLines && Math.abs(printedTotal - sumOfLines - (roundOff || 0)) > Math.max(1, printedTotal * 0.01)) {
    warnings.push({ code: 'BILL_TOTAL_MISMATCH', severity: 'review', message: `The lines add to ${Math.round(sumOfLines * 100) / 100}${roundOff ? ` with a round-off of ${roundOff}` : ''}, against a printed total of ${printedTotal}. Nothing was changed.` });
  }

  return {
    page, seller_name: seller, gstin, invoice_no: invoiceNo || null,
    invoice_date: toIsoDate(dateRaw), vehicle_no: vehicle, broker,
    total_amount: printedTotal, round_off: roundOff, tax_amount: taxAmount,
    columns, lines: goods, warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// One row, as a draft purchase
// ---------------------------------------------------------------------------------------------

/**
 * Present one consignment row and the bill it was linked to in the shape the existing draft
 * builder takes, so that party matching, duplicate detection, the unit conversions and
 * `purchaseCalc` are reused exactly as they are for a single-GRN document. No calculation is
 * duplicated here and no figure is invented: fields the row could not supply stay null.
 *
 * The list's printed deduction is carried as a reported figure, not applied: whether a moisture
 * loss is deducted is the company's rule, and this build does not decide it.
 */
export function asParsedDocument(row: GrnRow, document: { page: number; bill: BillHeader } | null, context: { issuer?: string | null; party_code?: string | null; buyer_gstin?: string | null; moisture_threshold_percent?: number | null } = {}) {
  const f = <T,>(value: T | null, confidence: Field<T>['confidence'], source: string, note?: string) => field(value, confidence, source, note);
  const bill = document?.bill || null;
  const line = bill?.lines?.[0] || null;

  const grn = {
    is_grn: true as const,
    issuer: f(context.issuer ?? null, context.issuer ? 'medium' : 'low', row.raw),
    sample_no: row.sample_no,
    grn_date: row.grn_date,
    truck_no: row.truck_no,
    supplier_name: row.supplier_name,
    bags: row.bags,
    net_weight_kg: row.net_weight_kg,
    freight_amount: row.freight_amount,
    load_unload: row.load_unload,
    rokdi: row.rokdi,
    moisture_percent: row.moisture_percent,
    // The existing draft reads a per-kilogram deduction here. The list prints a rupee amount, not
    // a rate, so this is left empty and the printed amount is reported instead.
    deduction_per_kg: f<number>(null, 'low', row.raw),
    party_code: f(context.party_code ?? null, 'low', row.raw),
    buyer_gstin: f(context.buyer_gstin ?? null, 'low', row.raw),
    moisture_threshold_percent: f(context.moisture_threshold_percent ?? null, 'low', row.raw),
    raw_row: row.raw,
  };

  const asBill = bill ? {
    is_bill: true as const,
    document_type: f<string>(bill.gstin ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY', 'medium', `page ${bill.page}`),
    seller_name: f(bill.seller_name, bill.seller_name ? 'medium' : 'low', `page ${bill.page}`),
    seller_address: f<string>(null, 'low', ''), seller_state: f<string>(null, 'low', ''),
    seller_gstin: f(bill.gstin, bill.gstin ? 'medium' : 'low', `page ${bill.page}`),
    seller_msme: f<string>(null, 'low', ''), destination: f<string>(null, 'low', ''),
    taxable_value: f<number>(null, 'low', ''),
    seller_contact: f<string>(null, 'low', ''), seller_email: f<string>(null, 'low', ''),
    bank_name: f<string>(null, 'low', ''), bank_account: f<string>(null, 'low', ''), bank_ifsc: f<string>(null, 'low', ''),
    invoice_no: f(bill.invoice_no, bill.invoice_no ? 'medium' : 'low', `page ${bill.page}`),
    invoice_date: f(bill.invoice_date, bill.invoice_date ? 'medium' : 'low', `page ${bill.page}`),
    vehicle_no: f(bill.vehicle_no, bill.vehicle_no ? 'medium' : 'low', `page ${bill.page}`),
    broker: f(bill.broker, bill.broker ? 'low' : 'low', `page ${bill.page}`),
    buyer_name: f<string>(null, 'low', ''), buyer_gstin: f<string>(null, 'low', ''), buyer_pan: f<string>(null, 'low', ''),
    round_off: f(bill.round_off, bill.round_off === null ? 'low' : 'medium', `page ${bill.page}`),
    items: (bill.lines || []).map((l) => ({
      description: l.description, hsn: l.hsn, packages: l.packages,
      quantity: l.quantity, quantity_unit: l.quantity_unit,
      rate: l.rate, rate_unit: l.rate_unit ?? l.quantity_unit, amount: l.amount,
      quantity_kg: l.quantity !== null && /qtl|quintal/i.test(String(l.quantity_unit || '')) ? Math.round(l.quantity * 100) : null,
      rate_per_kg: l.rate !== null && /qtl|quintal/i.test(String(l.rate_unit || l.quantity_unit || '')) ? Math.round((l.rate / 100) * 10000) / 10000 : null,
      quantity_unit_corrected: false, rate_unit_corrected: false,
      source: l.raw,
    })),
    tax_amount: f(bill.tax_amount, bill.tax_amount === null ? 'low' : 'medium', `page ${bill.page}`),
    total_amount: f(bill.total_amount, bill.total_amount === null ? 'low' : 'medium', `page ${bill.page}`),
  } : null;

  return { grn: grn as any, bill: asBill as any, unrecognised_pages: [], grn_page: row.page, bill_page: document?.page ?? null };
}

/** The list page's own details, which every row on it shares. */
export function listContext(text: string): { issuer: string | null; party_code: string | null; buyer_gstin: string | null; moisture_threshold_percent: number | null } {
  const ls = lines(text); const all = clean(ls.join(' '));
  return {
    issuer: ls.slice(0, 5).map(clean).find((l) => /LIMITED|LTD|PRIVATE|INDUSTRIES/i.test(l)) || null,
    party_code: /party\s*code\s*:?\s*([0-9A-Z-]{4,})/i.exec(all)?.[1] || null,
    buyer_gstin: (all.match(/\b\d{2}\s?[A-Z]{5}\s?\d{4}\s?[A-Z]\s?[0-9A-Z]\s?[A-Z0-9]\s?[0-9A-Z]\b/) || [null])[0]?.replace(/\s/g, '') || null,
    moisture_threshold_percent: toNumber(/MOISTURE CONTENT MORE TH[AE]N\s*([\d.]+)\s*%/i.exec(all)?.[1] || null),
  };
}


/**
 * A bill read by whichever parser gets further.
 *
 * `parseSupplierBill` reads the column order off the page, which is what makes an unfamiliar
 * layout work; `parseBillPage` is written against the Tally bill of supply and still reads that one
 * better. Neither is dropped: both run, the column-driven result is the base, and any field the
 * layout-specific parser filled that the generic one left empty is taken from it. So adding support
 * for new layouts cannot make a layout that already worked read worse.
 */
export function bestBill(text: string, page: number): BillHeader {
  const generic = parseSupplierBill(text, page);
  let specific: ReturnType<typeof parseBillPage> = null;
  try { specific = parseBillPage(text); } catch { specific = null; }
  if (!specific) return generic;

  const merged: BillHeader = { ...generic };
  const take = <K extends keyof BillHeader>(key: K, value: any) => {
    if ((merged[key] === null || merged[key] === undefined || merged[key] === '') && value !== null && value !== undefined && value !== '') merged[key] = value;
  };
  take('seller_name', specific.seller_name?.value);
  take('gstin', specific.seller_gstin?.value);
  take('invoice_no', specific.invoice_no?.value);
  take('invoice_date', specific.invoice_date?.value);
  take('vehicle_no', specific.vehicle_no?.value);
  take('broker', specific.broker?.value);
  take('total_amount', specific.total_amount?.value);
  take('tax_amount', specific.tax_amount?.value);

  const theirs = specific.items || [];
  if (!merged.lines.length && theirs.length) {
    merged.lines = theirs.map((item: any, i: number) => ({
      line: i + 1, description: item.description ?? null, hsn: item.hsn ?? null, packages: item.packages ?? null,
      quantity: item.quantity ?? null, quantity_unit: item.quantity_unit ?? null,
      rate: item.rate ?? null, rate_unit: item.rate_unit ?? null, amount: item.amount ?? null,
      calculated_check: item.quantity && item.amount ? Math.round((item.amount / item.quantity) * 100) / 100 : null,
      raw: item.source || '', warnings: [],
    }));
  } else {
    // Fill the cells the column-driven read left empty, line by line.
    merged.lines = merged.lines.map((line, i) => {
      const item: any = theirs[i];
      if (!item) return line;
      const filled = { ...line };
      for (const key of ['description', 'hsn', 'packages', 'quantity', 'quantity_unit', 'rate', 'rate_unit', 'amount'] as const) {
        if ((filled as any)[key] === null && item[key] !== null && item[key] !== undefined) (filled as any)[key] = item[key];
      }
      if (filled.quantity && filled.amount) filled.calculated_check = Math.round((filled.amount / filled.quantity) * 100) / 100;
      // A rate that the other parser supplied is no longer "not read".
      if (filled.rate !== null) filled.warnings = filled.warnings.filter((w) => !/RATE_(NOT_READ|COLUMN_ABSENT)/.test(w.code));
      return filled;
    });
  }
  return merged;
}
