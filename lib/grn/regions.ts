import type { WasmWord, WasmRect, WasmRegionRequest, WasmRegionRead } from './ocr-wasm';

/**
 * Finding the parts of a scanned page worth reading again, and rebuilding a table row from word
 * positions (v2.11.1).
 *
 * The whole-page pass lays a page out as one document. That is right for prose and for the bill's
 * header, but a goods-receipt table has narrow columns: a supplier name wider than its column is
 * printed wrapped, and the whole-page pass returns it as fragments on three different lines — on
 * the supplied sample, `AKSH`, then `ENTERPRIS` inside the data row, then a lone `E`. No amount of
 * string handling recovers that reliably, because the fragments are not adjacent in the text.
 *
 * So regions are located **from the words the first pass already found** — the labels printed on
 * the page — and never from pixel coordinates fixed for one document. Everything here is relative
 * to the anchors' own positions and to the page's measured extent, so a GRN printed at another
 * size, scanned at another resolution or laid out by another mill still resolves, and a page whose
 * anchors are absent simply yields no region instead of a wrong one.
 *
 * The row is then rebuilt by **column**: the header words give each column's horizontal span, and
 * every word of the data rows is assigned to the column its centre falls in. A cell wrapped over
 * several lines is joined in reading order, which is how `AKSH ENTERPRIS` + `E` becomes
 * `AKSH ENTERPRISE` without guessing.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.]/g, '');

/** The words of one anchor phrase, in order, as a box covering all of them. */
function findPhrase(words: WasmWord[], phrase: string[], opts: { from?: number } = {}): { rect: WasmRect; words: WasmWord[] } | null {
  const wanted = phrase.map(norm);
  const pool = words.filter((w) => w.y >= (opts.from ?? 0));
  for (let i = 0; i < pool.length; i++) {
    let k = 0; const hit: WasmWord[] = [];
    for (let j = i; j < pool.length && k < wanted.length; j++) {
      const t = norm(pool[j].text);
      if (!t) continue;
      if (t.startsWith(wanted[k]) || wanted[k].startsWith(t)) { hit.push(pool[j]); k++; }
      else if (hit.length) break;
      else break;
    }
    if (k === wanted.length && hit.length) {
      const x = Math.min(...hit.map((w) => w.x));
      const y = Math.min(...hit.map((w) => w.y));
      const right = Math.max(...hit.map((w) => w.x + w.width));
      const bottom = Math.max(...hit.map((w) => w.y + w.height));
      return { rect: { x, y, width: right - x, height: bottom - y }, words: hit };
    }
  }
  return null;
}

const anchorOf = (words: WasmWord[], phrases: string[][]) => {
  for (const p of phrases) { const hit = findPhrase(words, p); if (hit) return hit; }
  return null;
};

/** Is this page likely a goods-receipt note? Decided from the labels, before any field is parsed. */
export function looksLikeGrn(words: WasmWord[]): boolean {
  const joined = words.map((w) => norm(w.text)).join(' ');
  return /grnlist|grndate|statementofmaizereceipt/.test(joined.replace(/ /g, '')) || (/sampleno|sample/.test(joined.replace(/ /g, '')) && /truckno|truck/.test(joined.replace(/ /g, '')));
}

/** Is this page likely a supplier bill / invoice? */
export function looksLikeBill(words: WasmWord[]): boolean {
  const joined = words.map((w) => norm(w.text)).join('');
  return /billofsupply|taxinvoice/.test(joined) || (/invoiceno/.test(joined) && /hsn|sac/.test(joined));
}

/**
 * The regions worth a second pass on a GRN page: the receipt table (from its header row down to
 * the totals line or the notes beneath it) and the party-code line.
 */
export function grnRegions(words: WasmWord[], size: { width: number; height: number }): WasmRegionRequest[] {
  if (!size.width || !size.height) return [];
  const out: WasmRegionRequest[] = [];
  // The header is printed over more than one line, so every anchor we can find is used and the
  // region starts at the topmost of them — picking only the first match would begin the region
  // below a header line and lose a column.
  const headerHits = [['sample', 'no'], ['truck', 'no'], ['grn', 'date'], ['recd', 'net'], ['moist']]
    .map((p) => findPhrase(words, p)).filter(Boolean) as Array<{ rect: WasmRect; words: WasmWord[] }>;
  const header = headerHits.length
    ? headerHits.reduce((a, b) => (b.rect.y < a.rect.y ? b : a))
    : null;
  if (header) {
    // Down to whichever comes first: the totals line, or the notes that follow the table.
    const below = words.filter((w) => w.y > header.rect.y + header.rect.height);
    const stop = below.filter((w) => /^(total|please|freight|the)$/.test(norm(w.text))).sort((a, b) => a.y - b.y)[0];
    const pad = Math.max(6, Math.round(size.height * 0.004));
    const top = Math.max(0, header.rect.y - pad * 2);
    const bottom = stop ? Math.min(size.height, stop.y + stop.height + pad * 3) : Math.min(size.height, header.rect.y + Math.round(size.height * 0.12));
    out.push({ name: 'grn-receipt-table', rect: { x: 0, y: top, width: size.width, height: bottom - top }, psm: 6 });
  }
  const code = anchorOf(words, [['party', 'code'], ['partycode']]);
  if (code) {
    const pad = Math.round(size.height * 0.006);
    out.push({ name: 'grn-party-code', rect: { x: Math.max(0, code.rect.x - pad), y: Math.max(0, code.rect.y - pad), width: Math.min(size.width, code.rect.width * 6 + pad), height: code.rect.height + pad * 2 }, psm: 7 });
  }
  return out;
}

/**
 * The regions worth a second pass on a supplier bill: the header block that carries the invoice
 * number, date, vehicle and the GSTINs (where a neighbouring column routinely bleeds into the
 * value), and the goods table with the quantity, rate and amount.
 */
export function billRegions(words: WasmWord[], size: { width: number; height: number }): WasmRegionRequest[] {
  if (!size.width || !size.height) return [];
  const out: WasmRegionRequest[] = [];
  const invoice = anchorOf(words, [['invoice', 'no'], ['invoiceno']]);
  if (invoice) {
    const top = Math.max(0, invoice.rect.y - Math.round(size.height * 0.02));
    out.push({ name: 'bill-header', rect: { x: 0, y: top, width: size.width, height: Math.min(size.height - top, Math.round(size.height * 0.24)) }, psm: 6 });
  }
  const goods = anchorOf(words, [['hsn', 'sac'], ['hsn'], ['description', 'of'], ['sl', 'no']]);
  if (goods) {
    const top = Math.max(0, goods.rect.y - Math.round(size.height * 0.01));
    out.push({ name: 'bill-goods-table', rect: { x: 0, y: top, width: size.width, height: Math.min(size.height - top, Math.round(size.height * 0.22)) }, psm: 6 });
  }
  return out;
}

export type TableColumn = { label: string; x: number; right: number };
export type TableRow = Record<string, string>;

/**
 * Rebuild a table from word boxes: the header words define the columns, and each later word joins
 * the column its centre sits in. Returns the columns and one record per row of data, so a cell that
 * the document wrapped over two lines arrives whole.
 *
 * Nothing here is specific to one mill's layout: the labels come from the page.
 */
export function rebuildTable(words: WasmWord[], headerLabels: string[][]): { columns: TableColumn[]; rows: TableRow[] } | null {
  if (!words.length) return null;
  // The header's own line(s): every anchor phrase we can find, in page order.
  const found = headerLabels.map((p) => findPhrase(words, p)).filter(Boolean) as Array<{ rect: WasmRect; words: WasmWord[] }>;
  if (found.length < 2) return null;
  const headerBottom = Math.max(...found.map((h) => h.rect.y + h.rect.height));

  const columns: TableColumn[] = found
    .map((h, i) => ({ label: headerLabels[i].join(' '), x: h.rect.x, right: h.rect.x + h.rect.width }))
    .sort((a, b) => a.x - b.x);
  // Each column reaches to the midpoint between its own right edge and the next column's left edge.
  for (let i = 0; i < columns.length; i++) {
    const next = columns[i + 1];
    columns[i].right = next ? (columns[i].right + next.x) / 2 : Infinity;
    if (i > 0) columns[i].x = columns[i - 1].right;
  }
  if (columns.length) columns[0].x = 0;

  const body = words.filter((w) => w.y > headerBottom);
  if (!body.length) return null;
  // Group the body into visual rows: a new row starts where the vertical gap exceeds a line height.
  const lineHeight = median(body.map((w) => w.height)) || 10;
  const sorted = [...body].sort((a, b) => a.y - b.y || a.x - b.x);
  const bands: WasmWord[][] = [];
  for (const w of sorted) {
    const band = bands[bands.length - 1];
    if (band && Math.abs(w.y - band[0].y) <= lineHeight * 0.8) band.push(w);
    else bands.push([w]);
  }

  // A band that holds a value in the first column starts a record; bands that hold only
  // continuations (a wrapped cell) are folded into the record above them.
  const rows: TableRow[] = [];
  let pending: TableRow = {};
  for (const band of bands) {
    const cells: TableRow = {};
    for (const w of [...band].sort((a, b) => a.x - b.x)) {
      const centre = w.x + w.width / 2;
      const col = columns.find((c) => centre >= c.x && centre < c.right);
      if (!col) continue;
      cells[col.label] = cells[col.label] ? `${cells[col.label]} ${w.text}` : w.text;
    }
    if (!Object.keys(cells).length) continue;
    if (Object.keys(cells).length > 1) {
      // A data row. Anything held over from single-column bands above it is the start of its
      // wrapped cells, so it goes in front.
      for (const [k, v] of Object.entries(pending)) cells[k] = cells[k] ? joinWrapped(v, cells[k]) : v;
      pending = {};
      rows.push(cells);
    } else if (rows.length) {
      // A continuation of the row above: the rest of a cell the column was too narrow to hold.
      const last = rows[rows.length - 1];
      for (const [k, v] of Object.entries(cells)) last[k] = last[k] ? joinWrapped(last[k], v) : v;
    } else {
      // The first line of a cell whose row has not arrived yet.
      for (const [k, v] of Object.entries(cells)) pending[k] = pending[k] ? joinWrapped(pending[k], v) : v;
    }
  }
  // The totals line repeats two columns and is not a consignment; the parser excludes it too.
  const first = columns[0]?.label;
  return { columns, rows: rows.filter((r) => Object.keys(r).length > 1 && !/^total\b/i.test(String(r[first] || ''))) };
}

/**
 * Join a wrapped cell. A fragment that continues the previous word (`ENTERPRIS` + `E`) is joined
 * without a space; a separate word keeps its space. The test is the fragment's own shape: a short
 * run of letters with no space is a continuation, anything else is a new word.
 */
function joinWrapped(head: string, tail: string): string {
  const t = tail.trim();
  if (/^[A-Za-z]{1,3}$/.test(t) && /[A-Za-z]$/.test(head.trim())) return head.trim() + t;
  return `${head.trim()} ${t}`;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * The text a page's passes contribute to the parser. The whole-page text comes first, then each
 * region under a marked heading, so the parser can tell where a value came from and the same value
 * read twice does not become two different fields.
 */
export function combinePasses(pageText: string, regions: WasmRegionRead[], rebuilt: Array<{ name: string; lines: string[] }> = []): string {
  const parts = [pageText.trim()];
  for (const r of rebuilt) if (r.lines.length) parts.push(`[[region ${r.name} rebuilt]]\n${r.lines.join('\n')}`);
  for (const r of regions) if (r.text.trim()) parts.push(`[[region ${r.name}]]\n${r.text.trim()}`);
  return parts.filter(Boolean).join('\n');
}

/**
 * What each GRN column must look like if the rebuild assigned it correctly. A scan's word boxes do
 * not always line up with the header's — a column label printed over a neighbouring column, or a
 * line the engine merged, can shift a cell one column over. So the rebuilt row is **checked
 * against the shape of its own columns** and, if any cell is in the wrong kind of column, the whole
 * rebuild is discarded rather than handed on. A mislabelled weight is far worse than no rebuild:
 * the region's raw text is still contributed, and the whole-page pass still stands.
 */
const GRN_CELL_SHAPE: Array<[RegExp, RegExp]> = [
  [/^sample no$/, /^\d{3,6}\s*-\s*\d{3,6}$/],
  [/^grn date$/, /^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}$/],
  [/^truck no$/, /^[A-Z0-9 -]{3,16}$/],
  [/^bags$/, /^\d{1,6}$/],
  [/^recd net$/, /^\d{1,8}(\.\d+)?$/],
  [/^(freight|load|rokdi)$/, /^-?[\d,]+(\.\d+)?$/],
  [/^moist$/, /^\d{1,3}(\.\d+)?\s*%?$/],
  [/^deduction$/, /^-?[\d,]+(\.\d+)?$/],
];

/** Does this cell fit the kind of value its column holds? Columns with no rule are not judged. */
function cellFitsColumn(label: string, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  for (const [col, shape] of GRN_CELL_SHAPE) if (col.test(label)) return shape.test(v);
  return true;
}

/**
 * The rebuilt GRN row as `label: value` lines — or nothing at all, when any cell does not fit its
 * column. Never positional guesswork handed on as fact.
 */
export function grnRowLines(table: { columns: TableColumn[]; rows: TableRow[] } | null): string[] {
  if (!table || !table.rows.length) return [];
  const out: string[] = [];
  for (const row of table.rows) {
    const lines: string[] = [];
    for (const col of table.columns) {
      const v = row[col.label];
      if (!v || !v.trim()) continue;
      // One cell in the wrong column means the row's columns are not trustworthy: drop the row.
      if (!cellFitsColumn(col.label, v)) return [];
      lines.push(`${col.label}: ${v.trim()}`);
    }
    // A row that recovered only a cell or two is not a row; it is noise.
    if (lines.length >= 4) out.push(...lines);
  }
  return out;
}

/**
 * How much of what a page must yield the text actually yields (v2.11.1).
 *
 * This is the gate on the second pass, and the guard against it: a page whose first pass already
 * covers its required fields is not read again, and a second pass is only allowed to stand if it
 * covers *more* than the first did. So the extra passes can add a missing cell but can never take
 * a correctly read page and make it worse.
 */
export type Coverage = { kind: 'grn' | 'bill' | 'unknown'; required: string[]; missing: string[]; score: number };

const GRN_REQUIRED: Array<[string, (g: any) => boolean]> = [
  ['sample number', (g) => Boolean(g?.sample_no?.value)],
  ['GRN date', (g) => Boolean(g?.grn_date?.value)],
  ['truck number', (g) => Boolean(g?.truck_no?.value)],
  ['bags', (g) => Number.isFinite(g?.bags?.value) && g.bags.value !== null],
  ['received net weight', (g) => Number(g?.net_weight_kg?.value) > 0],
  ['moisture', (g) => g?.moisture_percent?.value !== null && g?.moisture_percent?.value !== undefined],
];
const BILL_REQUIRED: Array<[string, (b: any) => boolean]> = [
  ['invoice number', (b) => Boolean(b?.invoice_no?.value)],
  ['invoice date', (b) => Boolean(b?.invoice_date?.value)],
  ['vehicle number', (b) => Boolean(b?.vehicle_no?.value)],
  ['goods line', (b) => Boolean(b?.items?.length)],
  ['quantity', (b) => Number(b?.items?.[0]?.quantity) > 0],
  ['rate', (b) => Number(b?.items?.[0]?.rate) > 0],
  ['amount', (b) => Number(b?.total_amount?.value) > 0],
];

/** Measure a page's coverage with the real parser, so the gate uses the same rules as the draft. */
export function coverageOf(text: string, parsers: { grn: (t: string) => any; bill: (t: string) => any }): Coverage {
  const grn = parsers.grn(text);
  const bill = parsers.bill(text);
  const check = (reqs: Array<[string, (x: any) => boolean]>, doc: any) => {
    const missing = reqs.filter(([, ok]) => { try { return !ok(doc); } catch { return true; } }).map(([name]) => name);
    return { required: reqs.map(([n]) => n), missing, score: reqs.length - missing.length };
  };
  if (grn && !bill) return { kind: 'grn', ...check(GRN_REQUIRED, grn) };
  if (bill && !grn) return { kind: 'bill', ...check(BILL_REQUIRED, bill) };
  if (grn && bill) {
    const g = check(GRN_REQUIRED, grn); const b = check(BILL_REQUIRED, bill);
    return g.score >= b.score ? { kind: 'grn', ...g } : { kind: 'bill', ...b };
  }
  return { kind: 'unknown', required: [], missing: [], score: 0 };
}
