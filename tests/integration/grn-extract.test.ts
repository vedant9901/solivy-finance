/**
 * v2.10.0 — GRN scan to draft purchase, against the real sample document.
 *
 * The parser tests run against the committed recognition output of the supplied scan (OCR noise
 * and all), so they need no tools installed. The end-to-end test runs the real PDF through the
 * whole pipeline and is reported as skipped unless `SOLIVY_GRN_SAMPLE_PDF` points at it and
 * poppler and tesseract are present — the sample is a real vendor document and is not committed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseDocument, parseGrnPage, parseBillPage, linkGrnToBill, toIsoDate, toNumber, unitToKg, gstinIsValid, ifscIsValid } from '../../lib/grn/parse';
import { buildDraft, matchParty } from '../../lib/grn/draft';
import { purchaseCalc } from '../../lib/utils';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'grn');
const grnText = fs.readFileSync(path.join(FIX, 'sayaji-grn-page1.ocr.txt'), 'utf8');
const billText = fs.readFileSync(path.join(FIX, 'party-bill-page2.ocr.txt'), 'utf8');
const parsed = parseDocument([{ page: 1, text: grnText }, { page: 2, text: billText }]);

test('the GRN page yields every printed field of the sample document', () => {
  const grn = parsed.grn;
  assert.ok(grn, 'the GRN page is recognised');
  assert.equal(grn!.sample_no.value, '2627-22603');
  assert.equal(grn!.grn_date.value, '2026-10-17', 'printed 17.10.2026, read day-first');
  assert.equal(grn!.truck_no.value, '5630');
  assert.equal(grn!.bags.value, 375);
  assert.equal(grn!.net_weight_kg.value, 21262);
  assert.equal(grn!.freight_amount.value, 0);
  assert.equal(grn!.load_unload.value, 0);
  assert.equal(grn!.rokdi.value, 0);
  assert.equal(grn!.moisture_percent.value, 11.5);
  assert.equal(grn!.deduction_per_kg.value, 0);
  assert.equal(grn!.party_code.value, '0011000820');
  assert.equal(grn!.moisture_threshold_percent.value, 14, 'the deduction threshold printed on the GRN');
  assert.match(String(grn!.issuer.value), /SAYAJI INDUSTRIES LIMITED/);
  // The buyer's GSTIN is misread by the scanner (0661 for 0861) — it must be reported, not fixed.
  assert.equal(grn!.buyer_gstin.confidence, 'low');
  assert.match(String(grn!.buyer_gstin.note), /check digit/i);
});

test('the party bill yields the seller, the invoice, the vehicle and the goods line', () => {
  const bill = parsed.bill;
  assert.ok(bill, 'the bill page is recognised');
  assert.equal(bill!.document_type.value, 'BILL_OF_SUPPLY');
  assert.equal(bill!.seller_name.value, 'Deepak Enterprises');
  assert.match(String(bill!.seller_address.value), /Lonara Road Segaon/);
  assert.equal(bill!.seller_state.value, 'Madhya Pradesh');
  assert.equal(bill!.seller_msme.value, 'UDYAM-MP-28-0001910');
  assert.equal(bill!.invoice_no.value, '274');
  assert.equal(bill!.invoice_date.value, '2026-10-13');
  assert.equal(bill!.vehicle_no.value, 'GJ04X5630');
  assert.equal(bill!.broker.value, 'Shyam Broker');
  assert.equal(bill!.buyer_gstin.value, '24AADCS0861R1ZZ');
  assert.equal(bill!.buyer_gstin.confidence, 'high', 'this one passes its check digit');
  assert.equal(bill!.buyer_pan.value, 'AADCS0861R');
  assert.equal(bill!.tax_amount.value, 0, 'a bill of supply: the page states NIL');
  assert.equal(bill!.total_amount.value, 437800);

  const item = bill!.items[0];
  assert.ok(item, 'the goods line is read');
  assert.equal(item.description, 'Maize');
  assert.equal(item.hsn, '10059000');
  assert.equal(item.packages, 375);
  assert.equal(item.quantity, 218.9);
  assert.equal(item.rate, 2000);
  assert.equal(item.amount, 437800);
  // The brief expected a per-kg rate; this bill quotes per quintal, so the unit is read and used.
  assert.equal(item.quantity_kg, 21890);
  assert.equal(item.rate_per_kg, 20);
});

test('values the scanner got wrong are reported as uncertain, never corrected', () => {
  const bill = parsed.bill!;
  assert.equal(bill.seller_gstin.value, '23AAKPA7592B120', 'kept exactly as read');
  assert.equal(gstinIsValid('23AAKPA7592B120'), false);
  assert.equal(gstinIsValid('23AAKPA7592B1Z0'), true, 'the true GSTIN on the page passes');
  assert.equal(bill.seller_gstin.confidence, 'low');
  assert.equal(bill.bank_ifsc.value, 'ICICQ000867', 'read with a Q for the 0');
  assert.equal(ifscIsValid('ICICQ000867'), false);
  assert.equal(ifscIsValid('ICIC0000867'), true);
  assert.equal(bill.bank_ifsc.confidence, 'low');
  assert.match(String(bill.bank_ifsc.note), /not a valid IFSC/i);
});

test('the two pages are linked by vehicle number, package count and date', () => {
  const link = linkGrnToBill(parsed.grn, parsed.bill);
  assert.equal(link.linked, true);
  assert.equal(link.confidence, 'high');
  assert.match(link.reasons.join(' '), /5630 is the tail of the bill's vehicle number GJ04X5630/);
  assert.match(link.reasons.join(' '), /375 packages/);
});

test('a bill for a different vehicle is not linked to this GRN', () => {
  const other = parseBillPage(billText.replace('GJ04X5630', 'GJ99Z1111'))!;
  const link = linkGrnToBill(parsed.grn, other);
  assert.equal(link.confidence, 'low');
  assert.equal(link.linked, false);
  assert.match(link.reasons.join(' '), /Vehicle numbers differ/);
});

test('unit, number and date readers handle the forms these documents use', () => {
  assert.equal(toNumber('4,37,800.00'), 437800, 'Indian digit grouping');
  assert.equal(toNumber('21262'), 21262);
  assert.equal(toNumber('abc'), null);
  assert.equal(toIsoDate('17.10.2026'), '2026-10-17');
  assert.equal(toIsoDate('13-Oct-26'), '2026-10-13');
  assert.equal(toIsoDate('32.13.2026'), null);
  assert.equal(unitToKg('qtl.'), 100);
  assert.equal(unitToKg('qt!'), 100, 'as the scanner renders it');
  assert.equal(unitToKg('kg'), 1);
  assert.equal(unitToKg('MT'), 1000);
  assert.equal(unitToKg('bags'), null, 'an unknown unit is not guessed');
});

function company() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, gst TEXT DEFAULT '', pan TEXT DEFAULT '', address TEXT DEFAULT '', contact TEXT DEFAULT '', email TEXT DEFAULT '', party_type TEXT DEFAULT 'GOODS_VENDOR', active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE party_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id), alias TEXT NOT NULL UNIQUE);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_no TEXT, party_id INTEGER REFERENCES parties(id), purchase_date TEXT, invoice_no TEXT, truck_number TEXT, net_payable REAL DEFAULT 0);
    CREATE TABLE grn_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, file_sha256 TEXT, purchase_id INTEGER, status TEXT DEFAULT 'extracted');
  `);
  return d;
}

test('the draft maps the document onto the purchase form and values it with the approved rules', () => {
  const d = company();
  d.prepare("INSERT INTO parties(name,gst) VALUES('DEEPAK ENTERPRISES','23AAKPA7592B1Z0')").run();
  const draft = buildDraft(d, parsed, { companyDiscountRule: 1 });

  assert.equal(draft.purchase.sample_no, '2627-22603');
  assert.equal(draft.purchase.purchase_date, '2026-10-17', 'the GRN date, as the brief requires');
  assert.equal(draft.purchase.truck_number, 'GJ04X5630', 'the full registration from the bill');
  assert.equal(draft.purchase.invoice_no, '274');
  assert.equal(draft.purchase.hsn, '10059000');
  assert.equal(draft.purchase.goods_description, 'Maize');
  assert.equal(draft.purchase.bags_qty, 375);
  assert.equal(draft.purchase.net_weight, 21262, 'the weight the buyer actually received');
  assert.equal(draft.purchase.gross_weight, 21890, 'the quantity the bill was raised for');
  assert.equal(draft.purchase.rate, 20, '2,000 per quintal is 20.00 per kg');
  assert.equal(draft.purchase.freight, 0);
  assert.equal(draft.purchase.unload_charge, 0);
  assert.equal(draft.purchase.driver_rokdi, 0);
  assert.equal(draft.purchase.gst_type, 'NONE');
  assert.equal(draft.purchase.moisture, 0, 'the GRN percentage is not a rupee deduction');

  // The figures come from the one approved calculation, not from anything in this module.
  const expected = purchaseCalc({ ...draft.purchase, discount_after_quality: 1 });
  assert.equal(draft.calculation.gross_amount, expected.gross_amount);
  assert.equal(draft.calculation.net_payable, expected.net_payable);
  assert.equal(draft.calculation.gross_amount, 425240, '21,262 kg × ₹20.00');
  assert.equal(draft.calculation.net_payable, 425240, 'no deductions on this document');
});

test('the review points a person has to decide are raised, with the document as evidence', () => {
  const d = company();
  d.prepare("INSERT INTO parties(name,gst) VALUES('DEEPAK ENTERPRISES','23AAKPA7592B1Z0')").run();
  const draft = buildDraft(d, parsed, { companyDiscountRule: 1 });
  const codes = draft.warnings.map((w) => w.code);
  for (const code of ['RATE_CONVERTED', 'WEIGHT_DIFFERENCE', 'MOISTURE_REPORTED', 'NO_GST', 'GSTIN_UNCERTAIN', 'IFSC_UNCERTAIN', 'BROKER_FOUND']) {
    assert.ok(codes.includes(code), `${code} is raised: ${codes.join(', ')}`);
  }
  assert.match(draft.warnings.find((w) => w.code === 'WEIGHT_DIFFERENCE')!.message, /21890 kg.*21262 kg.*628/);
  assert.match(draft.warnings.find((w) => w.code === 'MOISTURE_REPORTED')!.message, /11\.5% moisture.*above 14%/);
  assert.ok(!draft.warnings.some((w) => w.severity === 'blocking'), `nothing blocks this document: ${JSON.stringify(draft.warnings.filter((w) => w.severity === 'blocking'))}`);
  assert.equal(draft.evidence['grn.net_weight_kg'].value, 21262);
  assert.match(String(draft.evidence['bill.line_item'].value), /218\.9 qtl\..*2000.*437800/);
});

test('the party is matched on GSTIN, and a party draft is offered when there is no match', () => {
  const withParty = company();
  withParty.prepare("INSERT INTO parties(name,gst) VALUES('Some Other Vendor','23AAKPA7592B1Z0')").run();
  // The GSTIN read from the scan fails its check digit, so it cannot be used to match: the name is.
  const byName = company();
  byName.prepare("INSERT INTO parties(name,gst) VALUES('Deepak Enterprises','')").run();
  const named = matchParty(byName, parsed.bill);
  assert.equal(named.matched, true);
  assert.equal(named.method, 'name');
  assert.equal(named.confidence, 'medium');

  const clean = company();
  clean.prepare("INSERT INTO parties(name,gst) VALUES('Deepak Enterprises','23AAKPA7592B1Z0')").run();
  const corrected = parseBillPage(billText.replace('23AAKPA7592B 120', '23AAKPA7592B1Z0'))!;
  const byGstin = matchParty(clean, corrected);
  assert.equal(byGstin.method, 'GSTIN');
  assert.equal(byGstin.confidence, 'high');

  const empty = company();
  const unmatched = matchParty(empty, parsed.bill);
  assert.equal(unmatched.matched, false);
  assert.equal(unmatched.draft!.name, 'Deepak Enterprises');
  assert.equal(unmatched.draft!.gst, '', 'a GSTIN that fails its check digit is not carried into the party');
  assert.equal(unmatched.draft!.gst_as_read, '23AAKPA7592B120', 'but it is reported, for the user to confirm');
  assert.equal(unmatched.draft!.contact, '+919100000000', 'the first usable number, not the whole line');
  assert.deepEqual(unmatched.draft!.contact_all, ['+919100000000', '9100000001']);
  assert.equal(unmatched.bank_draft!.account_number, '086705010000');
  assert.equal(unmatched.bank_draft!.ifsc, '', 'an invalid IFSC is not written into bank details');
  assert.equal(unmatched.bank_draft!.ifsc_as_read, 'ICICQ000867');
  const draft = buildDraft(empty, parsed, {});
  assert.ok(draft.warnings.some((w) => w.code === 'PARTY_NOT_FOUND'));
  assert.ok(draft.warnings.some((w) => w.code === 'PARTY_REQUIRED' && w.severity === 'blocking'), 'saving is blocked until a party is chosen');
});

test('a GRN, an invoice or a vehicle+date already entered is reported as a duplicate', () => {
  const d = company();
  d.prepare("INSERT INTO parties(name,gst) VALUES('Deepak Enterprises','')").run();
  d.prepare("INSERT INTO purchases(sample_no,party_id,purchase_date,invoice_no,truck_number) VALUES('2627-22603',1,'2026-10-17','274','GJ04X5630')").run();
  d.prepare("INSERT INTO grn_documents(file_sha256,purchase_id,status) VALUES('abc123',1,'linked')").run();
  const draft = buildDraft(d, parsed, { documentSha: 'abc123' });
  const kinds = draft.duplicates.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['document', 'invoice_no', 'sample_no', 'truck_date']);
  assert.match(draft.duplicates.find((x) => x.kind === 'document')!.detail, /already used for purchase 1/);
});

test('an unreadable page is reported rather than guessed', () => {
  const nothing = parseDocument([{ page: 1, text: 'scanned page with no recognisable text at all' }]);
  assert.equal(nothing.grn, null);
  assert.equal(nothing.bill, null);
  assert.deepEqual(nothing.unrecognised_pages, [1]);
  const d = company();
  const draft = buildDraft(d, nothing, {});
  const codes = draft.warnings.map((w) => w.code);
  assert.ok(codes.includes('NO_GRN_PAGE') && codes.includes('NO_BILL_PAGE'));
  assert.ok(draft.warnings.some((w) => w.severity === 'blocking'), 'an empty draft cannot be saved');
  assert.equal(draft.purchase.rate, 0);
});

test('a bill whose rate unit cannot be read blocks instead of assuming kilograms', () => {
  const weird = parseBillPage(billText.replace('218.90 qtl., 2,000.00) qt!', '218.90 bxs., 2,000.00) bxs'))!;
  const d = company();
  d.prepare("INSERT INTO parties(name,gst) VALUES('Deepak Enterprises','')").run();
  const draft = buildDraft(d, { grn: parsed.grn, bill: weird, unrecognised_pages: [], grn_page: 1, bill_page: 2 }, {});
  assert.ok(draft.warnings.some((w) => w.code === 'RATE_UNIT_UNKNOWN' && w.severity === 'blocking'), JSON.stringify(draft.warnings.map((w) => w.code)));
  assert.equal(draft.purchase.rate, 0, 'no rate is invented');
});

// ---- end to end over the real PDF, when the sample and the tools are available ----------------
const SAMPLE = process.env.SOLIVY_GRN_SAMPLE_PDF || '';
const sampleReady = SAMPLE && fs.existsSync(SAMPLE);
test('end to end: the real scanned PDF produces the same draft', { skip: sampleReady ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the sample document (it is not committed)' }, async () => {
  const { extractPdfText, availableTools } = await import('../../lib/grn/extract');
  const tools = availableTools();
  void tools; // v2.11.0: recognition no longer depends on an installed tool
  const extraction = await extractPdfText(fs.readFileSync(SAMPLE));
  assert.equal(extraction.page_count, 2);
  assert.equal(extraction.source, 'ocr', 'the sample is a scan with no text layer');
  const live = parseDocument(extraction.pages.map((p) => ({ page: p.page, text: p.text })));
  assert.equal(live.grn?.sample_no.value, '2627-22603');
  assert.equal(live.grn?.net_weight_kg.value, 21262);
  assert.equal(live.bill?.invoice_no.value, '274');
  assert.equal(live.bill?.vehicle_no.value, 'GJ04X5630');
  assert.equal(live.bill?.items[0]?.rate_per_kg, 20);
  const d = company();
  d.prepare("INSERT INTO parties(name,gst) VALUES('Deepak Enterprises','')").run();
  const draft = buildDraft(d, live, {});
  assert.equal(draft.purchase.net_weight, 21262);
  assert.equal(draft.calculation.gross_amount, 425240);
});

// ---- the whole workflow through the real endpoints -------------------------------------------
test('workflow: upload → draft → confirmed save → linked, with duplicates caught on re-upload', { skip: sampleReady ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the sample document' }, async () => {
  const { availableTools } = await import('../../lib/grn/extract');
  const tools = availableTools();
  void tools; // v2.11.0: recognition no longer depends on an installed tool
  const app = await import('../helpers/app');
  const session = await app.adminSession('LIVE');
  const upload = async () => {
    const body = new FormData();
    body.append('file', new File([new Uint8Array(fs.readFileSync(SAMPLE))], 'VRHUF-DEEPAKTRA-17.10.pdf', { type: 'application/pdf' }));
    body.append('keep_original', '1');
    return app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
  };

  const first = await upload();
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.recognised.grn, true);
  assert.equal(first.json.recognised.bill, true);
  assert.equal(first.json.draft.purchase.sample_no, '2627-22603');
  assert.equal(first.json.draft.purchase.net_weight, 21262);
  assert.equal(first.json.draft.purchase.rate, 20);
  assert.equal(first.json.draft.duplicates.length, 0);
  // No accounting entry exists yet: extraction alone posts nothing.
  assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 0, 'nothing was posted by the upload');
  assert.ok(first.json.draft.warnings.some((w: any) => w.code === 'PARTY_REQUIRED' && w.severity === 'blocking'), 'saving is blocked without a party');

  // The user creates the party from the bill and then confirms the purchase.
  const party = app.expectOk(await app.call('/api/parties', { cookie: session.cookie, body: { ...first.json.draft.party.draft, ...first.json.draft.party.bank_draft } }));
  const partyId = Number(party.id ?? party.partyId);
  assert.ok(partyId, JSON.stringify(party));
  const saved = await app.call('/api/purchases', { cookie: session.cookie, body: { ...first.json.draft.purchase, party_id: partyId } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(Math.round(saved.json.calc.gross_amount), 425240, '21,262 kg × ₹20.00, by the ordinary purchase rules');
  assert.equal(Math.round(saved.json.calc.net_payable), 425240);

  const linked = await app.call('/api/grn', { cookie: session.cookie, body: { action: 'link', document_id: first.json.document_id, purchase_id: saved.json.id } });
  assert.equal(linked.status, 200, linked.text);
  const listed = app.expectOk(await app.call('/api/grn', { cookie: session.cookie }));
  const row = listed.documents.find((x: any) => x.id === first.json.document_id);
  assert.equal(row.status, 'linked');
  assert.equal(row.purchase_id, saved.json.id);
  assert.equal(row.sample_no, '2627-22603', 'the document carries through to the purchase it created');
  assert.equal(Number(row.has_pdf), 1, 'the original was kept with the entry');

  // The same document again: the duplicate is reported before anything is entered twice.
  const second = await upload();
  assert.equal(second.status, 200, second.text);
  const kinds = second.json.draft.duplicates.map((x: any) => x.kind).sort();
  assert.ok(kinds.includes('document') && kinds.includes('sample_no') && kinds.includes('truck_date'), JSON.stringify(kinds));
  assert.match(second.json.draft.duplicates.find((x: any) => x.kind === 'document').detail, /already used for purchase/);

  // A linked document is part of the audit trail and cannot be discarded.
  const discard = await app.call('/api/grn', { cookie: session.cookie, body: { action: 'discard', document_id: first.json.document_id } });
  assert.equal(discard.status, 409, discard.text);
  assert.match(String(discard.json.error), /audit trail/);
  // Saving the same sample number twice is refused by the purchase endpoint itself.
  const again = await app.call('/api/purchases', { cookie: session.cookie, body: { ...first.json.draft.purchase, party_id: partyId } });
  assert.equal(again.status >= 400, true, 'a second identical purchase is refused');
  assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 1, 'exactly one purchase exists');
});
