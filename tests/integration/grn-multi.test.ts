/**
 * v2.12.0 — a consignment list is many GRNs, and a document is many pages.
 *
 * The acceptance fixture is the supplied thirteen-page S M CORPORATION scan: page 1 is a Sayaji
 * consignment list with twelve rows, then eleven supplier bills from three suppliers and a
 * handwritten slip. Before this release the pipeline read the first row and the first bill and
 * discarded the rest — eleven purchases lost.
 *
 * The document is a real vendor one, carrying GSTINs, bank details and contact numbers, so it is
 * **not committed**: these tests read it from `SOLIVY_GRN_SAMPLE_PDF_MULTI` and report themselves
 * as not verified without it. The committed fixture is masked OCR text of the list page, which is
 * what the row parsing is asserted against so that it is covered on every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyPage, countDataRows, parseGrnRows, listTotals, parseSupplierBill, parseDocumentSet, matchDocuments, asParsedDocument, listContext } from '../../lib/grn/multi';
import { normaliseGrnResponse } from '../../lib/grn/contract';
import { purchaseCalc } from '../../lib/utils';
import * as app from '../helpers/app';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'grn');
const listText = fs.readFileSync(path.join(FIX, 'consignment-list.ocr.txt'), 'utf8');
const invoiceText = fs.readFileSync(path.join(FIX, 'supplier-tax-invoice.ocr.txt'), 'utf8');
const billText = fs.readFileSync(path.join(FIX, 'supplier-bill-of-supply.ocr.txt'), 'utf8');

const MULTI = process.env.SOLIVY_GRN_SAMPLE_PDF_MULTI;
const multi = MULTI && fs.existsSync(MULTI) ? fs.readFileSync(MULTI) : null;
const needsMulti = multi ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF_MULTI to the supplied 13-page document';

// ---- the list: every row is its own GRN -------------------------------------------------------

test('every data row of the list is a separate GRN, and the total row is not one', () => {
  assert.equal(countDataRows(listText), 12, 'the page prints twelve consignments');
  const rows = parseGrnRows(listText, 1);
  assert.equal(rows.length, 12, 'and twelve were taken');
  assert.deepEqual(rows.map((r) => r.row), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'in printed order');
  assert.ok(rows.every((r) => !/^total/i.test(String(r.sample_no.value || ''))), 'no row is the total line');
  // Stable identity, from the page and the printed position — not an array index.
  assert.deepEqual(rows.map((r) => r.id), rows.map((_, i) => `p1r${i + 1}`));
  assert.equal(new Set(rows.map((r) => r.sample_no.value)).size, 12, 'every row has its own sample number');
});

test('the eleven columns of a row land in the right places', () => {
  const rows = parseGrnRows(listText, 1);
  const first = rows[0];
  assert.equal(first.sample_no.value, '2627-23766');
  assert.equal(first.grn_date.value, '2026-10-24', 'printed 24.10.2026');
  assert.equal(first.truck_no.value, '0139');
  assert.match(String(first.supplier_name.value), /PITAMBAR/);
  assert.equal(first.bags.value, 590);
  assert.equal(first.net_weight_kg.value, 30135);
  assert.equal(first.freight_amount.value, 0);
  assert.equal(first.load_unload.value, 590);
  assert.equal(first.rokdi.value, 455);
  assert.equal(first.moisture_percent.value, 19.5);
  assert.equal(first.deduction_amount.value, 2787.49);

  // A different row, to show it is not the first row's values being repeated.
  const seventh = rows[6];
  assert.equal(seventh.sample_no.value, '2627-24234');
  assert.equal(seventh.truck_no.value, '5386');
  assert.match(String(seventh.supplier_name.value), /KUSHAL/);
  assert.equal(seventh.bags.value, 495);
  assert.equal(seventh.net_weight_kg.value, 24472);
  assert.equal(seventh.moisture_percent.value, 20);
  assert.equal(seventh.deduction_amount.value, 2508.38);
});

test('a supplier name the column wrapped does not bleed into the next row', () => {
  const rows = parseGrnRows(listText, 1);
  // Each name belongs to its own row: the fragment printed above row 2 is row 2's, not row 1's.
  assert.ok(!/KUSHAL/.test(String(rows[5].supplier_name.value)), `row 6: ${rows[5].supplier_name.value}`);
  assert.ok(!/LAXMI/.test(String(rows[3].supplier_name.value)), `row 4: ${rows[3].supplier_name.value}`);
  for (const r of rows) {
    const name = String(r.supplier_name.value || '');
    const suppliers = ['PITAMBAR', 'LAXMI', 'KUSHAL', 'DAXMI', 'TRADER', 'TRADING', 'ENTERPRIS'];
    const distinct = new Set(suppliers.filter((sfx) => name.includes(sfx)).map((sfx) => (sfx === 'DAXMI' ? 'LAXMI' : sfx)).map((sfx) => (['TRADER', 'TRADING', 'ENTERPRIS'].includes(sfx) ? 'suffix' : sfx)));
    distinct.delete('suffix');
    assert.ok(distinct.size <= 1, `row ${r.row} names one supplier, not two: "${name}"`);
  }
});

test('a row whose figures are ambiguous leaves the money empty and says so', () => {
  const rows = parseGrnRows(listText, 1);
  const ambiguous = rows.filter((r) => r.warnings.some((w) => w.code === 'ROW_EXTRA_FIGURES'));
  assert.ok(ambiguous.length >= 1, 'the sample has such rows');
  for (const r of ambiguous) {
    assert.equal(r.rokdi.value, null, `row ${r.row}: the rokdi is left empty rather than guessed`);
    assert.equal(r.moisture_percent.value, null, `row ${r.row}: so is the moisture`);
    assert.equal(r.deduction_amount.value, null, `row ${r.row}: and the deduction`);
    assert.ok(r.bags.value !== null && r.net_weight_kg.value !== null, `row ${r.row}: the columns read from the front are still there`);
    const warning = r.warnings.find((w) => w.code === 'ROW_EXTRA_FIGURES')!;
    assert.match(warning.message, /left empty|could not be placed/i);
    assert.equal(warning.severity, 'review');
  }
});

test('a figure the scanner ran into a letter is flagged, not trusted', () => {
  const rows = parseGrnRows(listText, 1);
  const smudged = rows.filter((r) => r.warnings.some((w) => w.code === 'FIGURE_TOUCHING_LETTER'));
  assert.ok(smudged.length >= 1, 'the sample has one: a net weight printed against a letter');
  assert.ok(smudged.some((r) => r.warnings.some((w) => w.code === 'WEIGHT_PER_BAG_ODD')), 'and the weight per bag check catches it too');
});

test('the printed total is a cross-check, never a correction', () => {
  const rows = parseGrnRows(listText, 1);
  const totals = listTotals(listText, rows)!;
  assert.ok(totals, 'the total row was found');
  assert.equal(totals.printed.bags, 7601, 'the printed bag total');
  assert.ok(totals.summed.bags > 0 && totals.summed.bags !== 7601, 'the rows add to something different');
  const bags = totals.differences.find((d) => d.column === 'bags');
  assert.ok(bags, `the difference is reported: ${JSON.stringify(totals.differences)}`);
  assert.equal(bags!.printed, 7601);
  assert.equal(bags!.summed, totals.summed.bags);
  // And no row was altered to make the sum agree.
  assert.equal(rows.reduce((n, r) => n + (Number(r.bags.value) || 0), 0), totals.summed.bags);
});

// ---- classifying pages ------------------------------------------------------------------------

test('each kind of page is told apart, including through OCR noise', () => {
  assert.equal(classifyPage(listText, 1).kind, 'grn-list');
  assert.equal(classifyPage(invoiceText, 2).kind, 'tax-invoice');
  assert.equal(classifyPage(billText, 3).kind, 'bill-of-supply');
  // The heading as these scans actually read it.
  assert.equal(classifyPage('—- a\n| Billof suenly\nLAXMI TRADERS, CHOPDA\nInvoice No. LT/26-27/268', 4).kind, 'bill-of-supply');
  // A page with almost no machine-readable text is a slip, and is kept rather than dropped.
  const slip = classifyPage('aeah esa\nayers FATCATA ceHTAT\n9423188079', 5);
  assert.equal(slip.kind, 'receipt');
  assert.match(slip.evidence.join(' '), /handwriting|readable letters/i);
  // A page with plenty of readable text but no heading this build knows is "unknown" — it is kept
  // and shown, and nothing is claimed about it.
  const prose = 'This page carries a quantity of perfectly legible prose about an entirely different subject, with no heading, no invoice number, no HSN column and no goods table anywhere upon it, which is exactly the case that must not be guessed at.';
  assert.equal(classifyPage(prose, 6).kind, 'unknown');
});

// ---- bills: every goods line, and the rate kept separate --------------------------------------

test('a tax invoice yields its goods line with the rate separate from the amount', () => {
  const bill = parseSupplierBill(invoiceText, 2);
  assert.equal(bill.seller_name, 'PITAMBARA TRADING');
  assert.equal(bill.invoice_no, '42');
  assert.equal(bill.invoice_date, '2026-10-22');
  assert.equal(bill.vehicle_no, 'MP09HH0139');
  assert.equal(bill.lines.length, 1, 'the goods line was read');
  const line = bill.lines[0];
  assert.equal(line.description, 'Maize');
  assert.equal(line.hsn, '100500');
  assert.equal(line.packages, 590);
  assert.equal(line.quantity, 304.45);
  assert.match(String(line.quantity_unit), /QTL/i);
  assert.equal(line.rate, 2750, 'the rate as printed, not derived');
  assert.equal(line.amount, 837237.5);
  // The arithmetic is checked, and it agrees here.
  assert.ok(!line.warnings.some((w) => w.code === 'LINE_DOES_NOT_MULTIPLY'), line.warnings.map((w) => w.code).join(','));
  assert.equal(Math.round(line.quantity! * line.rate! * 100) / 100, line.amount);
});

test('a rate the bill does not print is reported as unread, and never derived from the amount', () => {
  const bill = parseSupplierBill(billText, 3);
  assert.equal(bill.lines.length, 1);
  const line = bill.lines[0];
  assert.equal(line.rate, null, 'the rate is not invented');
  assert.equal(line.quantity, 340.45);
  assert.equal(line.amount, 987305);
  assert.equal(line.calculated_check, 2900, 'amount over quantity is offered as a check');
  const warning = line.warnings.find((w) => /RATE_(COLUMN_ABSENT|NOT_READ)/.test(w.code));
  assert.ok(warning, line.warnings.map((w) => w.code).join(','));
  assert.match(warning!.message, /cross-check only|has not been used as the rate|Enter the rate/i);
});

test('figures are never placed in the wrong column to make a line fit', () => {
  // A line with one figure where the header prints three numeric columns.
  const text = ['Bill of Supply', 'Invoice No. 9', 'Description of Goods HSN/SAC Quantity Rate per Amount', '1 Makka 10059000'].join('\n');
  const bill = parseSupplierBill(text, 1);
  assert.equal(bill.lines.length, 1, 'the line is still reported');
  assert.equal(bill.lines[0].quantity, null);
  assert.equal(bill.lines[0].rate, null);
  assert.equal(bill.lines[0].amount, null);
  const w = bill.lines[0].warnings.find((x) => x.code === 'LINE_COLUMN_COUNT');
  assert.ok(w, bill.lines[0].warnings.map((x) => x.code).join(','));
  assert.match(w!.message, /wrong column|left empty/i);
});

// ---- linking ----------------------------------------------------------------------------------

test('a bill is linked to a row only on corroborating evidence, and a tie is reported', () => {
  const rows = parseGrnRows(listText, 1);
  const invoice = parseSupplierBill(invoiceText, 2);
  const matches = matchDocuments(rows, [{ page: 2, kind: 'tax-invoice', bill: invoice }]);
  assert.equal(matches.length, 1);
  const m = matches[0];
  assert.equal(m.grn_id, 'p1r1', `the vehicle and the bags point at row 1: ${JSON.stringify(m)}`);
  assert.equal(m.confidence, 'high');
  assert.ok(m.evidence.some((e) => /vehicle number ends 0139/.test(e)), m.evidence.join('; '));
  assert.ok(m.evidence.some((e) => /590 bags on both/.test(e)), m.evidence.join('; '));
  assert.deepEqual(m.conflicts, []);

  // A bill with nothing in common is not forced onto a row.
  const stranger = parseSupplierBill(['TAX INVOICE', 'OTHER TRADERS', 'invoice no 99 DATE - 01-01-2020', 'VEHICLE NO XX99YY9999',
    'S.NO. Description NO.of UOM NET rate per Amount', '1 Wheat 10 QTL. 5.00 100 500.00'].join('\n'), 9);
  const none = matchDocuments(rows, [{ page: 9, kind: 'tax-invoice', bill: stranger }]);
  assert.equal(none[0].grn_id, null, 'no link was forced');
  assert.ok(none[0].conflicts.length > 0, 'and the reasons are given');
});

// ---- the whole set, and one row as a draft ----------------------------------------------------

test('the set counts what was found, and extracted plus unresolved equals the rows printed', () => {
  const set = parseDocumentSet([{ page: 1, text: listText }, { page: 2, text: invoiceText }, { page: 3, text: billText }]);
  assert.equal(set.counts.pages, 3);
  assert.equal(set.counts.list_pages, 1);
  assert.equal(set.counts.rows_detected, 12);
  assert.equal(set.counts.rows_extracted + set.counts.rows_unresolved, set.counts.rows_detected, 'nothing is lost between the two');
  assert.equal(set.counts.documents, 2);
  assert.equal(set.counts.goods_lines, 2);
  assert.equal(set.grns.length, 12);
  assert.equal(set.pages.length, 3);
});

test('one row becomes a draft purchase through the existing calculation, with nothing invented', () => {
  const set = parseDocumentSet([{ page: 1, text: listText }, { page: 2, text: invoiceText }]);
  const row = set.grns[0];
  const doc = set.documents.find((d) => d.page === 2)!;
  const parsed = asParsedDocument(row, doc, listContext(listText));
  assert.equal(parsed.grn.sample_no.value, '2627-23766');
  assert.equal(parsed.grn.net_weight_kg.value, 30135, 'the received weight');
  assert.equal(parsed.bill.items[0].quantity_kg, 30445, 'the dispatched weight, kept separate');
  assert.notEqual(parsed.bill.items[0].quantity_kg, parsed.grn.net_weight_kg.value);
  assert.equal(parsed.bill.items[0].rate_per_kg, 27.5, '₹2,750 a quintal is ₹27.50 a kilogram');
  // The list prints a rupee deduction, not a per-kilogram rate: it is not passed through as one.
  assert.equal(parsed.grn.deduction_per_kg.value, null);
  // And the calculation is the purchase form's own.
  const calc = purchaseCalc({ net_weight: 30135, rate: 27.5, freight: 0, unload_charge: 590, driver_rokdi: 455, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, discount_after_quality: 1 } as any);
  assert.equal(Math.round(calc.gross_amount), Math.round(30135 * 27.5));
});

// ---- the endpoint, against the real thirteen-page document ------------------------------------

test('the real 13-page document yields every page, every row and every bill — and posts nothing', { skip: needsMulti }, async () => {
  const session = await app.adminSession('LIVE');
  const body = new FormData();
  body.append('file', new File([new Uint8Array(multi!)], 'S M CORPORATION.pdf', { type: 'application/pdf' }));
  const r = await app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
  assert.equal(r.status, 200, r.text);
  const n = normaliseGrnResponse(r.json, r.status);

  assert.equal(n.extraction.page_count, 13, 'all thirteen pages');
  assert.equal(n.page_classifications.length, 13, 'and all thirteen are classified');
  assert.equal(n.counts.list_pages, 1);
  assert.equal(n.counts.rows_detected, 12, 'twelve consignment rows detected');
  assert.equal(n.grns.length, 12, 'twelve GRNs returned, not one');
  assert.equal(n.counts.rows_extracted + n.counts.rows_unresolved, 12);
  assert.ok(n.documents.length >= 10, `the supplier bills: ${n.documents.length}`);
  assert.ok(n.counts.goods_lines >= 9, `goods lines: ${n.counts.goods_lines}`);

  // Every row is distinct and carries its own draft.
  assert.equal(new Set(n.grns.map((g) => g.id)).size, 12);
  assert.equal(new Set(n.grns.map((g) => g.cells.sample_no.value)).size, 12);
  for (const g of n.grns) {
    assert.ok(g.draft && g.draft.purchase, `${g.id} has its own draft`);
    assert.equal(typeof g.draft.calculation.net_payable, 'number');
    assert.ok(g.draft.warnings.some((w) => w.severity === 'blocking'), `${g.id} still requires a party before saving`);
  }
  // The rate reached at least one draft, converted from quintals.
  assert.ok(n.grns.some((g) => Number(g.draft.purchase.rate) > 0), 'a rate came through to a draft');

  // At least one bill was linked on real evidence, and at least one was left unlinked rather than
  // forced onto a row.
  assert.ok(n.matches.some((m) => m.grn_id && m.confidence === 'high' && m.evidence.length >= 2), 'an evidence-based link');
  assert.ok(n.matches.some((m) => !m.grn_id), 'and a bill that was not forced onto a row');

  // Every page is accounted for: a classification each, and the pages nothing was made of are
  // still listed rather than dropped.
  assert.deepEqual([...n.page_classifications.map((p) => p.page)].sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i + 1));

  // The printed total disagrees with the rows on this document, and that is reported.
  assert.ok(n.totals, 'the totals were read');
  assert.ok(n.totals!.differences.length > 0, 'and the disagreement is reported rather than corrected');

  // Nothing was posted by any of it.
  const data = app.expectOk(await app.call('/api/data', { cookie: session.cookie }));
  assert.equal(data.purchases.length, 0, 'no purchase');
  assert.equal((data.payments || []).length, 0, 'no payment');
  assert.equal((data.parties || []).length, 0, 'no party');
});
