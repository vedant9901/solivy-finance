/**
 * Reading a GRN page and a party bill page (v2.10.0).
 *
 * Written against the real document supplied — a Sayaji Industries "GRN List Report" and a
 * Tally-style "Bill of Supply" from the party — and against the actual recognition output of that
 * scan, noise included (`23AAKPA7592B 120` for a GSTIN, `ICICQ000867` for an IFSC, `qt!` for
 * `qtl.`). Nothing here is assumed about a layout that was not in front of me.
 *
 * Two rules throughout:
 *  - every field carries a confidence and the line it came from, so the review screen can show
 *    where a value came from and flag what to check;
 *  - a value that fails its own validation is reported as found-but-uncertain, never silently
 *    corrected and never dropped.
 *
 * Note for the record: the brief expected the bill rate to be quoted per KG. The supplied bill
 * quotes **per quintal** (`2,000.00 per qtl.`), so the unit is read from the document and
 * converted; it is not assumed.
 */
export type Field<T> = { value: T | null; confidence: 'high' | 'medium' | 'low'; source: string; note?: string };
export const field = <T>(value: T | null, confidence: Field<T>['confidence'], source = '', note?: string): Field<T> => ({ value, confidence, source, note });

const clean = (s: string) => s.replace(/ /g, ' ').replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length > 0);

/** "4,37,800.00" (Indian grouping), "21262", "218.90" → number. Returns null when not a number. */
export function toNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 17.10.2026 · 17-10-2026 · 13-Oct-26 · 2026-10-17 → ISO. Day-first: these are Indian documents. */
export function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const month = Number(m[2]); const day = Number(m[1]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (!month) return null;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  return null;
}

/** Official GSTIN check digit (mod 36). A GSTIN that fails it is reported, never corrected. */
export function gstinIsValid(gstin: string) {
  const g = String(gstin || '').toUpperCase().replace(/\s/g, '');
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][A-Z0-9][0-9A-Z]$/.test(g)) return false;
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = alphabet.indexOf(g[i]);
    if (v < 0) return false;
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return alphabet[(36 - (sum % 36)) % 36] === g[14];
}

export const ifscIsValid = (s: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(s || '').toUpperCase().replace(/\s/g, ''));
export const panIsValid = (s: string) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(s || '').toUpperCase().replace(/\s/g, ''));

/** Quantity units seen on these bills, in kilograms. */
const UNIT_KG: Record<string, number> = { kg: 1, kgs: 1, qtl: 100, qtls: 100, quintal: 100, quintals: 100, mt: 1000, ton: 1000, tons: 1000, tonne: 1000, tonnes: 1000 };
/**
 * Misreadings of these three units that recognition produces often enough to be worth naming.
 * Accepting one is **not** a silent correction: `unitToKgDetailed` reports that it corrected the
 * reading, and the draft raises a review warning naming both what was printed and what was
 * assumed, so the user confirms the unit against the page. Nothing outside this closed set of
 * units is ever guessed at.
 */
const UNIT_OCR_VARIANTS: Record<string, number> = {
  qt: 100, ql: 100, qti: 100, gtl: 100, atl: 100, atls: 100, at: 100, qtt: 100, qfl: 100, otl: 100,
  kgm: 1, kq: 1, ka: 1,
  rnt: 1000, nt: 1000,
};
export function unitToKgDetailed(unit: string | null | undefined): { factor: number | null; corrected: boolean; read: string } {
  const read = String(unit || '');
  const u = read.toLowerCase().replace(/[^a-z]/g, '');
  if (!u) return { factor: null, corrected: false, read };
  if (UNIT_KG[u] !== undefined) return { factor: UNIT_KG[u], corrected: false, read };
  if (UNIT_OCR_VARIANTS[u] !== undefined) return { factor: UNIT_OCR_VARIANTS[u], corrected: true, read };
  return { factor: null, corrected: false, read };
}
export function unitToKg(unit: string | null | undefined): number | null {
  return unitToKgDetailed(unit).factor;
}

// ---------------------------------------------------------------------------------------------
// GRN page
// ---------------------------------------------------------------------------------------------
export type GrnPage = {
  is_grn: true;
  issuer: Field<string>; sample_no: Field<string>; grn_date: Field<string>; truck_no: Field<string>;
  supplier_name: Field<string>; bags: Field<number>; net_weight_kg: Field<number>;
  freight_amount: Field<number>; load_unload: Field<number>; rokdi: Field<number>;
  moisture_percent: Field<number>; deduction_per_kg: Field<number>;
  party_code: Field<string>; buyer_gstin: Field<string>; moisture_threshold_percent: Field<number>;
  raw_row: string;
};

export function looksLikeGrn(text: string) {
  const t = text.toUpperCase();
  return /GRN\s*(LIST|DATE|NO)/.test(t) || /STATEMENT OF MAIZE RECEIPT/.test(t) || (/SAMPLE\s*NO/.test(t) && /RECD/.test(t));
}

export function parseGrnPage(text: string): GrnPage | null {
  if (!looksLikeGrn(text)) return null;
  const ls = lines(text);
  const all = ls.join('\n');

  // The data row: a sample number, a date, then the numeric columns in the order printed on the
  // report — Recd. Bags, Net Recd. Wt, Freight, Load/Unload, Rokdi, Moist %, Deduction for Kg.
  // The "Total" line repeats two of them and is deliberately excluded.
  let row = '';
  for (const l of ls) {
    if (/^\s*total\b/i.test(l)) continue;
    if (/\b\d{3,6}\s*-\s*\d{3,6}\b/.test(l) && /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/.test(l)) { row = clean(l); break; }
  }
  const sample = /(\d{3,6}\s*-\s*\d{3,6})/.exec(row)?.[1]?.replace(/\s/g, '') || null;
  const dateRaw = /(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/.exec(row)?.[1] || null;
  const afterDate = dateRaw ? row.slice(row.indexOf(dateRaw) + dateRaw.length) : row;
  const truck = /(?:^|\s)([A-Z]{0,3}\s?\d{2,4}\s?[A-Z]{0,3}\s?\d{3,4}|\d{3,5})(?=\s|$)/.exec(afterDate)?.[1]?.replace(/\s/g, '') || null;
  const numbers = (afterDate.match(/-?\d[\d,]*\.?\d*/g) || []).map((x) => toNumber(x)).filter((x): x is number => x !== null);
  // The truck number is the first token after the date when it is purely numeric; drop it so the
  // seven measurement columns line up.
  const measures = truck && /^\d+$/.test(truck) && numbers[0] === Number(truck) ? numbers.slice(1) : numbers;
  const [bags, netWt, freight, loadUnload, rokdi, moisture, deductionPerKg] = measures;

  // The supplier's name sits in a narrow column, so a name wider than the column is printed
  // wrapped and comes back as fragments on three different lines — on the supplied sample `AKSH`
  // above the row, `ENTERPRIS` inside it and a lone `E` below. The fragment in the row alone is a
  // truncation, so the neighbouring lines are folded back into the cell: a short all-letters line
  // immediately above it begins the name, and one to three letters immediately below continue the
  // word it was broken across. Anything else is left alone, and the result is reported as
  // reassembled rather than as read.
  const rowIndex = row ? ls.findIndex((l) => clean(l) === row) : -1;
  const fragmentOnRow = /([A-Z]{3,}(?:\s+[A-Z]{3,})*)/.exec(afterDate.replace(/\d|[.,]/g, ' '))?.[1]?.trim() || null;
  const isNameFragment = (l: string | undefined, maxWords: number) => {
    const t = clean(l || '');
    return Boolean(t) && !/\d/.test(t) && /^[A-Z][A-Z .&-]*$/.test(t) && t.split(/\s+/).length <= maxWords && t.length <= 24;
  };
  let supplierOnRow = fragmentOnRow;
  let supplierJoined = false;
  if (fragmentOnRow && rowIndex >= 0) {
    const above = ls[rowIndex - 1];
    const below = ls[rowIndex + 1];
    if (isNameFragment(above, 3)) { supplierOnRow = `${clean(above)} ${supplierOnRow}`; supplierJoined = true; }
    if (below && /^[A-Z]{1,3}$/.test(clean(below))) { supplierOnRow = `${supplierOnRow}${clean(below)}`; supplierJoined = true; }
  }
  const toBlock = ls.findIndex((l) => /^\s*to\s*$/i.test(clean(l)) || /^\s*to\b/i.test(clean(l)));
  const addressee = toBlock >= 0 ? clean(ls.slice(toBlock, toBlock + 3).join(' ')).replace(/^to\s*/i, '') : '';
  const issuer = ls.slice(0, 4).map(clean).find((l) => /LIMITED|LTD|PRIVATE|INDUSTRIES|ENTERPRISE/i.test(l)) || clean(ls[1] || ls[0] || '');

  const gstins = (all.replace(/\s/g, ' ').match(/\b\d{2}\s?[A-Z]{5}\s?\d{4}\s?[A-Z]\s?[0-9A-Z]\s?[A-Z0-9]\s?[0-9A-Z]\b/g) || []).map((g) => g.replace(/\s/g, ''));
  const partyCode = /party\s*code\s*:?\s*([0-9A-Z-]{4,})/i.exec(all.replace(/\s+/g, ' '))?.[1] || null;
  const threshold = toNumber(/MOISTURE CONTENT MORE TH[AE]N\s*([\d.]+)\s*%/i.exec(all.replace(/\s+/g, ' '))?.[1] || null);

  const conf = (v: any): Field<any>['confidence'] => (v === null || v === undefined ? 'low' : 'medium');
  return {
    is_grn: true,
    issuer: field(issuer || null, issuer ? 'medium' : 'low', ls[1] || ''),
    sample_no: field(sample, sample ? 'high' : 'low', row),
    grn_date: field(toIsoDate(dateRaw), toIsoDate(dateRaw) ? 'high' : 'low', row, dateRaw ? `printed as ${dateRaw}` : undefined),
    truck_no: field(truck, truck ? 'medium' : 'low', row, truck && /^\d+$/.test(truck) ? 'The GRN prints only part of the registration; the bill carries the full number.' : undefined),
    supplier_name: field(supplierOnRow || addressee || null, supplierOnRow ? 'medium' : 'low', row,
      supplierJoined ? `The name is printed wrapped inside its column; it was reassembled from the lines around the row (read as "${fragmentOnRow}" in the row itself). Check it against the page.` : undefined),
    bags: field(bags ?? null, conf(bags), row),
    net_weight_kg: field(netWt ?? null, conf(netWt), row, 'Net weight received, as weighed by the buyer.'),
    freight_amount: field(freight ?? null, conf(freight), row),
    load_unload: field(loadUnload ?? null, conf(loadUnload), row),
    rokdi: field(rokdi ?? null, conf(rokdi), row),
    moisture_percent: field(moisture ?? null, conf(moisture), row, 'A percentage, not an amount.'),
    deduction_per_kg: field(deductionPerKg ?? null, conf(deductionPerKg), row),
    party_code: field(partyCode, partyCode ? 'medium' : 'low', ''),
    buyer_gstin: field(gstins[0] || null, gstins[0] ? (gstinIsValid(gstins[0]) ? 'high' : 'low') : 'low', '', gstins[0] && !gstinIsValid(gstins[0]) ? 'The check digit does not match; confirm it against the page.' : undefined),
    moisture_threshold_percent: field(threshold, threshold ? 'medium' : 'low', '', threshold ? `The GRN states losses are deducted above ${threshold}%.` : undefined),
    raw_row: row,
  };
}

// ---------------------------------------------------------------------------------------------
// Party bill page
// ---------------------------------------------------------------------------------------------
export type BillItem = { description: string | null; hsn: string | null; packages: number | null; quantity: number | null; quantity_unit: string | null; rate: number | null; rate_unit: string | null; amount: number | null; rate_per_kg: number | null; quantity_kg: number | null; quantity_unit_corrected: boolean; rate_unit_corrected: boolean; source: string };
export type BillPage = {
  is_bill: true;
  document_type: Field<string>;
  seller_name: Field<string>; seller_address: Field<string>; seller_gstin: Field<string>; seller_state: Field<string>;
  seller_contact: Field<string>; seller_email: Field<string>; seller_msme: Field<string>;
  buyer_name: Field<string>; buyer_gstin: Field<string>; buyer_pan: Field<string>;
  invoice_no: Field<string>; invoice_date: Field<string>; broker: Field<string>;
  vehicle_no: Field<string>; destination: Field<string>;
  items: BillItem[]; taxable_value: Field<number>; tax_amount: Field<number>; total_amount: Field<number>;
  bank_name: Field<string>; bank_account: Field<string>; bank_ifsc: Field<string>;
};

export function looksLikeBill(text: string) {
  const t = text.toUpperCase();
  return /BILL OF SUPPLY|TAX INVOICE|INVOICE NO/.test(t) && /(HSN|QUANTITY|RATE)/.test(t);
}

export function parseBillPage(text: string): BillPage | null {
  if (!looksLikeBill(text)) return null;
  const ls = lines(text);
  const flat = ls.map(clean).join('\n');
  const one = flat.replace(/\n/g, ' ');

  const gstins = (one.match(/\b\d{2}\s?[A-Z]{5}\s?\d{4}\s?[A-Z]\s?[0-9A-Z]\s?[A-Z0-9]\s?[0-9A-Z]\b/g) || []).map((g) => g.replace(/\s/g, ''));
  const buyerAt = flat.search(/buyer\s*\(?bill\s*to\)?/i);
  const sellerText = buyerAt > 0 ? flat.slice(0, buyerAt) : flat;
  const buyerText = buyerAt > 0 ? flat.slice(buyerAt) : '';
  const sellerGstin = (sellerText.match(/\b\d{2}\s?[A-Z]{5}\s?\d{4}\s?[A-Z]\s?[0-9A-Z]\s?[A-Z0-9]\s?[0-9A-Z]\b/) || [])[0]?.replace(/\s/g, '') || gstins[0] || null;
  const buyerGstin = (buyerText.match(/\b\d{2}\s?[A-Z]{5}\s?\d{4}\s?[A-Z]\s?[0-9A-Z]\s?[A-Z0-9]\s?[0-9A-Z]\b/) || [])[0]?.replace(/\s/g, '') || gstins.find((g) => g !== sellerGstin) || null;

  // The seller is the first substantial line of the document body, above its address.
  // In this layout the seller's name sits in the left column of the line that opens the
  // invoice box ("Invoice No. | Dated"), and its address follows on the lines below.
  const headerSkip = /bill of supply|tax invoice|shree|ganeshay|namah|^\W*$/i;
  const named = (l: string) => (l.match(/[A-Za-z]{3,}/g) || []).length >= 2;
  const sellerAll = sellerText.split('\n').map(clean).filter((l) => l && !headerSkip.test(l));
  const invoiceLine = sellerAll.find((l) => /invoice\s*no/i.test(l)) || '';
  const sellerName = (invoiceLine ? clean(invoiceLine.split(/invoice\s*no/i)[0]).replace(/^[^A-Za-z]+/, '') : '')
    || sellerAll.find((l) => named(l) && !/invoice|dated|delivery/i.test(l))?.replace(/^[^A-Za-z]+/, '') || null;
  const sellerStart = sellerAll.indexOf(invoiceLine);
  const sellerAddress = sellerAll.slice(Math.max(0, sellerStart) + 1, Math.max(0, sellerStart) + 3)
    .map((l) => clean(l.split(/delivery note|reference no|invoice no|\(\d/i)[0]))
    .filter((l) => l && !/gstin|msme|state name|contact|e-?mail/i.test(l)).join(', ') || null;

  const buyerLines = buyerText.split('\n').map(clean).filter((l) => l && !/^buyer\s*\(?bill\s*to\)?/i.test(l) && named(l));
  const buyerName = buyerLines[0] ? clean(buyerLines[0].split(/\s{2,}|dispatch|delivery note/i)[0]).replace(/^[^A-Za-z]+/, '') : null;

  const pick = (re: RegExp, from = one) => re.exec(from)?.[1]?.trim() || null;
  // The number is printed under its label, immediately before the date in the same box.
  const sellerRows = sellerText.split('\n').map(clean);
  const labelRow = sellerRows.findIndex((l) => /invoice\s*no/i.test(l));
  const underLabel = labelRow >= 0 ? sellerRows[labelRow + 1] || '' : '';
  // The row the invoice number was read from is kept as its evidence: every field has to be able
  // to say where it came from, not only those read through `pick`.
  const invoiceMatch = /[({\['"]?([A-Z0-9][A-Z0-9/\-]{0,19})\s+\d{1,2}[-\s.\/][A-Za-z0-9]{2,}[-\s.\/]\d{2,4}/.exec(underLabel);
  const invoiceNo = invoiceMatch?.[1]?.replace(/^[^A-Z0-9]+/i, '')
    || pick(/invoice\s*no\.?\s*:?\s*([A-Z0-9][A-Z0-9/\-]{0,19})\b(?!\s*dated)/i)
    || null;
  const invoiceSource = invoiceNo
    ? (invoiceMatch ? clean(invoiceMatch[0]) : (sellerRows.find((l) => new RegExp(`\\b${invoiceNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l)) || '')) || 'read from the invoice-number box'
    : '';
  const invoiceDate = toIsoDate(pick(/(\d{1,2}[-\s][A-Za-z]{3,}[-\s]\d{2,4})/) || pick(/dated\s*:?\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/i));
  const broker = pick(/\b([A-Z][A-Za-z]{1,20}(?:\s+[A-Z][A-Za-z]{1,20})?\s+Broker)\b/)
    || (labelRow >= 0 ? (sellerRows.slice(labelRow, labelRow + 4).map((l) => /delivery\s*note/i.test(l) ? '' : '').join('') || null) : null);
  const vehicleRaw = pick(/motor\s*vehicle\s*no\.?\s*\|?\s*([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{3,4})/i)
    || pick(/\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{3,4})\b/);
  const vehicle = vehicleRaw?.replace(/\s/g, '').toUpperCase() || null;
  const vehicleSource = vehicle ? (ls.map(clean).find((l) => l.replace(/\s/g, '').toUpperCase().includes(vehicle)) || `read as "${vehicleRaw}"`) : '';
  const destination = pick(/destination\s*\|?\s*\n?\s*([A-Za-z][A-Za-z .-]{2,30})/i, flat);

  // Line items: description, HSN, quantity + unit, rate + unit, amount.
  const items: BillItem[] = [];
  for (const l of ls.map(clean)) {
    if (/^total\b/i.test(l)) continue;
    const m = /(?:^|\s)(\d{1,5})?\s*([A-Za-z][A-Za-z ()\/-]{2,30}?)\s+(\d{6,8})\s+([\d,]+\.?\d*)\s*([A-Za-z.!]{2,8})?\s*,?\s*([\d,]+\.?\d*)\s*\)?\s*([A-Za-z.!]{2,8})?\s+([\d,]+\.\d{2})[^\d]{0,4}$/.exec(l);
    if (!m) continue;
    const quantity = toNumber(m[4]); const rate = toNumber(m[6]); const amount = toNumber(m[8]);
    if (quantity === null || rate === null || amount === null) continue;
    const quantityUnit = m[5] || null; const rateUnit = m[7] || m[5] || null;
    const q = unitToKgDetailed(quantityUnit); const r = unitToKgDetailed(rateUnit);
    items.push({
      description: clean(m[2]) || null, hsn: m[3] || null, packages: toNumber(m[1] || '') ?? null,
      quantity, quantity_unit: quantityUnit, rate, rate_unit: rateUnit, amount,
      quantity_kg: q.factor ? Math.round(quantity * q.factor * 1000) / 1000 : null,
      rate_per_kg: r.factor ? Math.round((rate / r.factor) * 10000) / 10000 : null,
      quantity_unit_corrected: q.corrected, rate_unit_corrected: r.corrected,
      source: l,
    });
  }

  // The printed totals are the noisiest part of a scan (the supplied page recognises its own
  // total as "24,37,800.00"), so the line items are authoritative and the printed figure is
  // reported as a cross-check when it disagrees.
  const itemsTotal = items.length ? Math.round(items.reduce((a, b) => a + (b.amount || 0), 0) * 100) / 100 : null;
  const printedTotals = (one.match(/[\d][\d,]*\.\d{2}/g) || []).map((x) => toNumber(x)).filter((x): x is number => x !== null);
  const nearestPrinted = itemsTotal === null ? null : printedTotals.find((x) => Math.abs(x - itemsTotal) < 0.01) ?? null;
  const totalAmount = itemsTotal ?? (printedTotals.length ? Math.max(...printedTotals) : null);
  const taxable = toNumber(pick(/taxable[^\n]{0,40}\n[^\n]{0,60}?([\d][\d,]*\.\d{2})/i, flat)) ?? itemsTotal;
  const taxWordsNil = /tax\s*amount\s*\(in words\)\s*:?\s*nil/i.test(one);
  const bankName = pick(/bank\s*name\s*:?\s*([A-Za-z0-9 .&\/-]{3,60}?)\s*(?:A\/?c|Alc|Branch|$)/i);
  const account = pick(/(?:A\/c|Alc|Account)\s*(?:No\.?)?\s*:?\s*([0-9]{6,20})/i);
  const ifscLine = flat.split('\n').map(clean).find((l) => /IFS\s*C?o?d?e?/i.test(l)) || '';
  const ifsc = (ifscLine.toUpperCase().match(/[A-Z]{4}[A-Z0-9]{7}/g) || []).find((t) => /\d/.test(t)) || null;
  const pan = pick(/PAN\s*\/?\s*I?T?\s*No\.?\s*:?\s*([A-Z]{5}\s?[0-9]{4}\s?[A-Z])/i)?.replace(/\s/g, '') || null;
  const state = pick(/state\s*name\s*:?\s*([A-Za-z ]{3,30}?)\s*,?\s*code/i);
  const contact = pick(/contact\s*:?\s*([+0-9 \-,/]{8,40})/i);
  const email = pick(/e-?mail\s*:?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  const msme = pick(/(UDYAM-[A-Z]{2}-\d{2}-\d{5,9})/i)?.toUpperCase() || null;
  const docType = /bill of supply/i.test(one) ? 'BILL_OF_SUPPLY' : /tax invoice/i.test(one) ? 'TAX_INVOICE' : null;

  return {
    is_bill: true,
    document_type: field(docType, docType ? 'high' : 'low', '', docType === 'BILL_OF_SUPPLY' ? 'A bill of supply carries no GST.' : undefined),
    seller_name: field(sellerName, sellerName ? 'medium' : 'low', invoiceLine || ''),
    seller_address: field(sellerAddress, sellerAddress ? 'low' : 'low', ''),
    seller_gstin: field(sellerGstin, sellerGstin ? (gstinIsValid(sellerGstin) ? 'high' : 'low') : 'low', '', sellerGstin && !gstinIsValid(sellerGstin) ? 'The check digit does not match what was read; confirm it against the page before using it.' : undefined),
    seller_state: field(state, state ? 'medium' : 'low', ''),
    seller_contact: field(contact ? clean(contact) : null, contact ? 'low' : 'low', ''),
    seller_email: field(email, email ? 'medium' : 'low', ''),
    seller_msme: field(msme, msme ? 'medium' : 'low', ''),
    buyer_name: field(buyerName, buyerName ? 'medium' : 'low', ''),
    buyer_gstin: field(buyerGstin, buyerGstin ? (gstinIsValid(buyerGstin) ? 'high' : 'low') : 'low', ''),
    buyer_pan: field(pan, pan ? (panIsValid(pan) ? 'high' : 'low') : 'low', ''),
    invoice_no: field(invoiceNo, invoiceNo ? 'medium' : 'low', invoiceSource),
    invoice_date: field(invoiceDate, invoiceDate ? 'high' : 'low', ''),
    broker: field(broker ? clean(broker) : null, broker ? 'low' : 'low', '', broker ? 'Printed in the delivery-note box; confirm whether it is the broker.' : undefined),
    vehicle_no: field(vehicle, vehicle ? 'high' : 'low', vehicleSource),
    destination: field(destination ? clean(destination) : null, destination ? 'low' : 'low', ''),
    items,
    taxable_value: field(taxable, taxable ? 'medium' : 'low', ''),
    tax_amount: field(taxWordsNil ? 0 : null, taxWordsNil ? 'high' : 'low', '', taxWordsNil ? 'The bill states the tax amount is NIL.' : 'No tax amount was found; check the page.'),
    total_amount: field(totalAmount, totalAmount ? 'medium' : 'low', ''),
    bank_name: field(bankName ? clean(bankName) : null, bankName ? 'medium' : 'low', ''),
    bank_account: field(account, account ? 'medium' : 'low', ''),
    bank_ifsc: field(ifsc, ifsc ? (ifscIsValid(ifsc) ? 'high' : 'low') : 'low', '', ifsc && !ifscIsValid(ifsc) ? 'This is not a valid IFSC pattern; confirm it against the page.' : undefined),
  };
}

export type ParsedDocument = { grn: GrnPage | null; bill: BillPage | null; unrecognised_pages: number[]; grn_page: number | null; bill_page: number | null };

export function parseDocument(pages: Array<{ page: number; text: string }>): ParsedDocument {
  let grn: GrnPage | null = null; let bill: BillPage | null = null; const unrecognised: number[] = [];
  let grnPage: number | null = null; let billPage: number | null = null;
  for (const p of pages) {
    const asGrn: GrnPage | null = !grn ? parseGrnPage(p.text) : null;
    if (asGrn) { grn = asGrn; grnPage = p.page; continue; }
    const asBill: BillPage | null = !bill ? parseBillPage(p.text) : null;
    if (asBill) { bill = asBill; billPage = p.page; continue; }
    unrecognised.push(p.page);
  }
  return { grn, bill, unrecognised_pages: unrecognised, grn_page: grnPage, bill_page: billPage };
}

/**
 * How confidently the two pages belong together. The GRN prints a short truck number ("5630") and
 * the bill the full registration ("GJ04X5630"), so a digit-suffix match is the reliable link, as
 * the brief expects; bag count, supplier name and dates corroborate it.
 */
export function linkGrnToBill(grn: GrnPage | null, bill: BillPage | null) {
  const reasons: string[] = []; let score = 0;
  if (!grn || !bill) return { linked: false, confidence: 'low' as const, reasons: ['Only one of the two pages was recognised.'], score };
  const grnTruck = String(grn.truck_no.value || '').replace(/\s/g, '').toUpperCase();
  const billVehicle = String(bill.vehicle_no.value || '').replace(/\s/g, '').toUpperCase();
  if (grnTruck && billVehicle) {
    const grnDigits = grnTruck.replace(/\D/g, ''); const billDigits = billVehicle.replace(/\D/g, '');
    if (billVehicle === grnTruck) { score += 50; reasons.push(`Vehicle number matches exactly (${billVehicle}).`); }
    else if (grnDigits.length >= 3 && billDigits.endsWith(grnDigits)) { score += 40; reasons.push(`The GRN truck number ${grnTruck} is the tail of the bill's vehicle number ${billVehicle}.`); }
    else {
      // Two vehicle numbers that positively disagree are evidence AGAINST the pages belonging
      // together, so matching package counts and nearby dates must not carry the link on their own.
      score -= 30;
      reasons.push(`Vehicle numbers differ: GRN ${grnTruck} against bill ${billVehicle}.`);
    }
  } else reasons.push('A vehicle number is missing on one of the pages.');

  const bags = grn.bags.value; const pkgs = bill.items[0]?.packages ?? null;
  if (bags !== null && pkgs !== null) {
    if (bags === pkgs) { score += 25; reasons.push(`Both pages show ${bags} packages.`); }
    else reasons.push(`Package counts differ: GRN ${bags} against bill ${pkgs}.`);
  }
  const grnDate = grn.grn_date.value; const billDate = bill.invoice_date.value;
  if (grnDate && billDate) {
    const days = Math.abs((Date.parse(grnDate) - Date.parse(billDate)) / 86_400_000);
    if (days <= 15) { score += 15; reasons.push(`The bill is dated ${billDate} and the GRN ${grnDate}, ${Math.round(days)} day(s) apart.`); }
    else reasons.push(`The bill (${billDate}) and the GRN (${grnDate}) are ${Math.round(days)} days apart.`);
  }
  const confidence = score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { linked: score >= 40, confidence: confidence as 'high' | 'medium' | 'low', reasons, score };
}
