/**
 * v2.11.0 — the OCR engine that ships with SOLIVY.
 *
 * The acceptance condition for this release: a scanned GRN is recognised on a machine where
 * **nothing is installed** — no Tesseract, no Poppler, no PATH entry, no environment variable.
 * Every test here removes any system tool first (the overrides point at a path that does not exist
 * and PATH is emptied), so what passes is what such a machine gets. The bundled engine is left in
 * place, which is the whole point; the case where it is missing too is in `grn-native.test.ts`.
 *
 * The acceptance figures come from the supplied document and are asserted exactly: the parser must
 * find the printed fields, not merely return some text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractPdfText, availableTools } from '../../lib/grn/extract';
import { engineInfo, recogniseImage, disposeEngine, vendorDir } from '../../lib/grn/ocr-wasm';
import { readPdf } from '../../lib/grn/pdf-native';
import { parseDocument, linkGrnToBill } from '../../lib/grn/parse';
import { purchaseCalc } from '../../lib/utils';
import { normaliseGrnResponse } from '../../lib/grn/contract';
import * as app from '../helpers/app';

const NOWHERE = path.join(path.sep, 'solivy-no-such-tool', 'absent');
const TOOLS = ['SOLIVY_PDFTOTEXT', 'SOLIVY_PDFTOPPM', 'SOLIVY_TESSERACT'] as const;

/** Run `fn` with no Tesseract and no Poppler anywhere on the machine. */
async function withNothingInstalled<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = TOOLS.map((k) => [k, process.env[k]] as const);
  const prevPath = process.env.PATH;
  for (const k of TOOLS) process.env[k] = NOWHERE;
  process.env.PATH = path.join(path.sep, 'solivy-no-such-tool');
  try { return await fn(); }
  finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
  }
}

const SAMPLE = process.env.SOLIVY_GRN_SAMPLE_PDF;
const sample = SAMPLE && fs.existsSync(SAMPLE) ? fs.readFileSync(SAMPLE) : null;
const needsSample = sample ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the supplied document (it is not committed)';

// ---- the engine itself -----------------------------------------------------------------------

test('the bundled engine is present, licensed and found without anything installed', async () => {
  await withNothingInstalled(() => {
    assert.deepEqual(availableTools(), { pdftotext: null, pdftoppm: null, tesseract: null }, 'the machine really has no tools');
    const info = engineInfo();
    assert.equal(info.available, true, `the engine must ship with SOLIVY: ${info.reason}`);
    assert.equal(info.reason, null);
    assert.ok(info.languages.includes('eng'), `English data is present: ${info.languages.join(', ')}`);
    // Resolved from the module's own location, never the working directory.
    assert.ok(path.isAbsolute(info.dir) && info.dir.includes(path.join('vendor', 'tesseract-wasm')), info.dir);
    for (const f of ['tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm.js', 'NOTICE.md', path.join('licenses', 'LICENSE-tesseract.txt'), path.join('licenses', 'LICENSE-tessdata.txt')]) {
      assert.ok(fs.existsSync(path.join(vendorDir(), f)), `${f} ships with the engine`);
    }
  });
});

test('the engine recognises a page image handed to it directly, and reports its confidence', { skip: needsSample }, async () => {
  await withNothingInstalled(async () => {
    const doc = readPdf(sample!, { withImages: true });
    const image = doc.pages[0].images[0];
    assert.equal(image.mime, 'image/jpeg', 'the page image goes to OCR as it sits in the PDF — no Poppler');
    const r = await recogniseImage(image.bytes, { dpi: Math.round(image.width / (doc.pages[0].width / 72)) });
    assert.ok(r.text.replace(/\s/g, '').length > 300, `the page produced text (${r.text.length} chars)`);
    assert.match(r.text, /GRN|SAYAJI/i);
    assert.ok(r.confidence > 50, `the engine reports a mean confidence: ${r.confidence}`);
    assert.ok(r.ms > 0 && r.ms < 120_000, `and how long it took: ${r.ms}ms`);
  });
});

// ---- the acceptance test ---------------------------------------------------------------------

test('the real two-page scan is read automatically with nothing installed, and every printed field is found', { skip: needsSample }, async () => {
  await withNothingInstalled(async () => {
    const extraction = await extractPdfText(sample!);

    // Both pages recognised, by the bundled engine, with diagnostics for each.
    assert.equal(extraction.page_count, 2);
    assert.equal(extraction.source, 'ocr');
    assert.equal(extraction.engine.kind, 'bundled-wasm');
    assert.match(String(extraction.engine.version), /^\d+\.\d+/, `the engine reports its version: ${extraction.engine.version}`);
    assert.equal(extraction.pages.length, 2, 'both pages were read');
    assert.deepEqual(extraction.diagnostics.map((d) => d.status), ['recognised', 'recognised']);
    for (const d of extraction.diagnostics) {
      assert.equal(d.engine, 'bundled-wasm');
      assert.ok(d.ms > 0, `page ${d.page} records its duration`);
      assert.ok(d.chars > 300, `page ${d.page} produced ${d.chars} characters`);
      assert.ok((d.confidence ?? 0) > 40, `page ${d.page} records a confidence: ${d.confidence}`);
    }

    // The parser — not the OCR — decides what was recognised.
    const parsed = parseDocument(extraction.pages.map((p) => ({ page: p.page, text: p.text })));
    assert.equal(parsed.grn_page, 1, 'the GRN is page 1');
    assert.equal(parsed.bill_page, 2, 'the bill is page 2');
    assert.deepEqual(parsed.unrecognised_pages, []);

    const grn = parsed.grn!;
    assert.ok(grn, 'the GRN page is recognised');
    assert.equal(grn.sample_no.value, '2627-22603');
    assert.equal(grn.grn_date.value, '2026-10-17', 'printed 17.10.2026');
    assert.equal(grn.truck_no.value, '5630');
    assert.equal(grn.bags.value, 375);
    assert.equal(grn.net_weight_kg.value, 21262, 'received net weight');
    assert.equal(grn.moisture_percent.value, 11.5);
    assert.equal(grn.moisture_threshold_percent.value, 14, 'the threshold the GRN itself prints');

    const bill = parsed.bill!;
    assert.ok(bill, 'the bill page is recognised');
    assert.equal(bill.seller_name.value, 'Deepak Enterprises');
    assert.equal(bill.invoice_no.value, '274');
    assert.equal(bill.invoice_date.value, '2026-10-13', 'printed 13-Oct-26');
    assert.equal(bill.vehicle_no.value, 'GJ04X5630');
    const item = bill.items[0];
    assert.equal(item.packages, 375);
    assert.equal(item.hsn, '10059000');
    assert.match(String(item.description), /Maize/i);
    assert.equal(item.quantity, 218.9, 'dispatched quantity in quintals, as printed');
    assert.equal(item.quantity_kg, 21890, 'converted to kg');
    assert.equal(item.rate, 2000);
    assert.equal(item.rate_per_kg, 20, '₹2,000 per quintal is ₹20 per kg');
    assert.equal(item.amount, 437800);

    // Every field carries its confidence and the page it came from.
    const cited = [
      ['grn.sample_no', grn.sample_no], ['grn.net_weight_kg', grn.net_weight_kg],
      ['bill.invoice_no', bill.invoice_no], ['bill.vehicle_no', bill.vehicle_no],
    ] as const;
    for (const [name, f] of cited) {
      assert.ok(['high', 'medium', 'low'].includes(f.confidence), `${name} records a confidence`);
      assert.ok(String(f.source || f.note || '').length > 0, `${name} records the evidence behind it`);
    }
  });
});

test('the two pages are linked on corroborating evidence, and the reasons are stated', { skip: needsSample }, async () => {
  await withNothingInstalled(async () => {
    const extraction = await extractPdfText(sample!);
    const parsed = parseDocument(extraction.pages.map((p) => ({ page: p.page, text: p.text })));
    const link = linkGrnToBill(parsed.grn, parsed.bill);
    assert.equal(link.linked, true);
    assert.equal(link.confidence, 'high');
    const why = link.reasons.join(' ');
    assert.match(why, /5630/, `the vehicle corroborates: ${why}`);
    assert.match(why, /375 packages/, 'the package count corroborates');
    assert.match(why, /day\(s\) apart/, 'and the dates corroborate');
  });
});

test('dispatched and received weights stay separate, and no deduction is invented', { skip: needsSample }, async () => {
  await withNothingInstalled(async () => {
    const extraction = await extractPdfText(sample!);
    const parsed = parseDocument(extraction.pages.map((p) => ({ page: p.page, text: p.text })));
    const { buildDraft } = await import('../../lib/grn/draft');
    const Database = require('better-sqlite3');
    const d = new Database(':memory:');
    d.exec(`
      CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, gst TEXT DEFAULT '', pan TEXT DEFAULT '', address TEXT DEFAULT '', contact TEXT DEFAULT '', email TEXT DEFAULT '', party_type TEXT DEFAULT 'GOODS_VENDOR', active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE party_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL, alias TEXT NOT NULL UNIQUE);
      CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_no TEXT, party_id INTEGER, purchase_date TEXT, invoice_no TEXT, truck_number TEXT, net_payable REAL DEFAULT 0);
      CREATE TABLE grn_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, file_sha256 TEXT, purchase_id INTEGER, status TEXT DEFAULT 'extracted');
    `);
    const draft = buildDraft(d as any, parsed, { documentSha: extraction.sha256, companyDiscountRule: 1 });

    assert.equal(draft.purchase.net_weight, 21262, 'the GRN’s received weight is what the purchase is valued on');
    // The dispatched weight depends on the unit printed beside it. Whichever way recognition read
    // that unit, the received weight must never be written into the gross-weight field.
    if (draft.purchase.gross_weight) {
      assert.equal(draft.purchase.gross_weight, 21890, 'the bill’s dispatched weight is kept, separate from the received one');
      assert.ok(draft.warnings.some((w: any) => w.code === 'WEIGHT_DIFFERENCE' && /628/.test(w.message)), 'and the 628 kg difference is raised for review');
    } else {
      assert.ok(draft.warnings.some((w: any) => w.code === 'DISPATCHED_WEIGHT_UNKNOWN'), 'or it is left empty and said so');
      assert.notEqual(draft.purchase.gross_weight, draft.purchase.net_weight, 'never the received weight in its place');
    }
    const unitNote = draft.warnings.find((w: any) => w.code === 'UNIT_CORRECTED');
    if (unitNote) assert.match(String(unitNote.message), /Check the unit on the page/, 'a unit read through a known misreading is flagged, never accepted silently');

    // Moisture: 11.5% against the 14% threshold the GRN prints, so no deduction.
    assert.equal(draft.purchase.moisture, 0, 'no moisture deduction is proposed');
    assert.equal(draft.purchase.discount_pct, 0);
    assert.equal(draft.purchase.quality_deduct_per_mt, 0);
    const moisture = draft.warnings.find((w: any) => w.code === 'MOISTURE_REPORTED');
    assert.ok(moisture, 'but the reading is reported');
    assert.match(String(moisture.message), /11\.5%[\s\S]*above 14%/);
    assert.match(String(moisture.message), /No moisture deduction is proposed/);

    // The total comes from the existing calculation, on the received weight.
    const calc = purchaseCalc({ ...draft.purchase, discount_after_quality: 1 });
    assert.equal(calc.gross_amount, 425240, '21,262 kg × ₹20');
    assert.equal(calc.total_deduction, 0);
    assert.equal(calc.net_payable, 425240);
    assert.equal(draft.calculation.net_payable, calc.net_payable, 'the draft uses purchaseCalc, not its own arithmetic');
    assert.ok(draft.warnings.some((w: any) => w.code === 'BILL_VS_RECEIVED'), 'and the difference from the bill’s own total is explained');
  });
});

// ---- through the endpoint --------------------------------------------------------------------

test('uploading the scan with nothing installed returns a reviewable draft and posts nothing', { skip: needsSample }, async () => {
  const session = await app.adminSession('LIVE');
  await withNothingInstalled(async () => {
    const body = new FormData();
    body.append('file', new File([new Uint8Array(sample!)], 'VRHUF-DEEPAKTRA-17.10.pdf', { type: 'application/pdf' }));
    body.append('keep_original', '1');
    const r = await app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
    assert.equal(r.status, 200, r.text);
    const n = normaliseGrnResponse(r.json, r.status);

    assert.equal(n.ok, true);
    assert.equal(n.manual_entry, false, 'the document was read, so this is a review and not manual entry');
    assert.equal(n.extraction.engine.kind, 'bundled-wasm');
    assert.equal(n.extraction.diagnostics.length, 2);
    assert.equal(n.recognised.grn, true);
    assert.equal(n.recognised.bill, true);
    assert.equal(n.draft.purchase.sample_no, '2627-22603');
    assert.equal(n.draft.purchase.net_weight, 21262);
    assert.equal(n.draft.purchase.gross_weight, 21890);
    assert.equal(n.draft.purchase.rate, 20);
    assert.equal(n.draft.purchase.truck_number, 'GJ04X5630');
    assert.equal(n.draft.purchase.invoice_no, '274');
    assert.equal(n.draft.purchase.hsn, '10059000');
    assert.equal(n.draft.calculation.net_payable, 425240);
    assert.ok(Object.keys(n.draft.evidence).length > 5, 'the evidence behind the fields is returned');

    // Nothing accounting-related was created by the upload.
    const data = app.expectOk(await app.call('/api/data', { cookie: session.cookie }));
    assert.equal(data.purchases.length, 0, 'no purchase');
    assert.equal((data.payments || []).length, 0, 'no payment');
    assert.equal((data.parties || []).length, 0, 'and no party was created from the bill');
  });
});

test('no network request is made while a document is read', { skip: needsSample }, async () => {
  // OCR is local by construction; this fails the test if any code on the path reaches the network.
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = (...args: any[]) => { calls.push(String(args[0])); throw new Error('the OCR path must not use the network'); };
  try {
    await withNothingInstalled(async () => {
      const extraction = await extractPdfText(sample!);
      assert.equal(extraction.pages.length, 2);
    });
    assert.deepEqual(calls, [], 'no outbound request was attempted');
  } finally { (globalThis as any).fetch = realFetch; }
});

// ---- failure handling ------------------------------------------------------------------------

test('a missing language file is reported with the fix, and nothing is claimed to be read', async () => {
  const previous = process.env.SOLIVY_GRN_OCR_LANG;
  process.env.SOLIVY_GRN_OCR_LANG = 'xyz';
  disposeEngine();
  try {
    await withNothingInstalled(async () => {
      const info = engineInfo();
      assert.equal(info.available, false);
      assert.match(String(info.reason), /Language data for xyz/);
      assert.match(String(info.reason), /SOLIVY_GRN_OCR_LANG/);
      const { jsPDF } = require('jspdf');
      const doc = new jsPDF(); doc.addPage();
      const extraction = await extractPdfText(Buffer.from(doc.output('arraybuffer')));
      assert.equal(extraction.engine.kind, 'none');
      assert.equal(extraction.pages.length, 0, 'nothing is claimed to have been read');
      assert.ok(extraction.diagnostics.every((d) => d.status === 'not-attempted'));
    });
  } finally {
    if (previous === undefined) delete process.env.SOLIVY_GRN_OCR_LANG; else process.env.SOLIVY_GRN_OCR_LANG = previous;
    disposeEngine();
  }
});

test('an unreadable page image is recorded as a failure, not as an empty success', async () => {
  await withNothingInstalled(async () => {
    await assert.rejects(() => recogniseImage(Buffer.from('this is not an image at all')), /could not be decoded/i);
    // The engine stays usable afterwards.
    const r = await recogniseImage(fs.readFileSync(path.join(vendorDir(), 'tessdata', 'eng.traineddata')).subarray(0, 0)).catch((e) => e);
    assert.ok(r instanceof Error, 'an empty image is refused too');
  });
});

test('recognition has a time budget, and a page it does not reach is marked not attempted', { skip: needsSample }, async () => {
  const previous = process.env.SOLIVY_GRN_OCR_BUDGET_MS;
  process.env.SOLIVY_GRN_OCR_BUDGET_MS = '1';       // the budget is spent before the first page
  try {
    await withNothingInstalled(async () => {
      const extraction = await extractPdfText(sample!);
      assert.equal(extraction.pages.length, 0, 'no page was read');
      assert.equal(extraction.diagnostics[0].status, 'not-attempted');
      assert.match(String(extraction.diagnostics[0].detail), /budget|not attempted/i);
      assert.ok(extraction.notes.some((n) => /SOLIVY_GRN_OCR_BUDGET_MS/.test(n)), 'and the limit is named');
      assert.deepEqual(extraction.viewable_pages, [1, 2], 'the pages can still be read by eye');
    });
  } finally { if (previous === undefined) delete process.env.SOLIVY_GRN_OCR_BUDGET_MS; else process.env.SOLIVY_GRN_OCR_BUDGET_MS = previous; }
});

test('a corrupt, encrypted or oversized upload is still refused before any recognition', async () => {
  const session = await app.adminSession('LIVE');
  const post = async (name: string, bytes: Buffer, type = 'application/pdf') => {
    const body = new FormData();
    body.append('file', new File([new Uint8Array(bytes)], name, { type }));
    return app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
  };
  await withNothingInstalled(async () => {
    const encrypted = await post('locked.pdf', Buffer.from('%PDF-1.4\n1 0 obj<</Encrypt 2 0 R>>endobj\ntrailer<</Encrypt 2 0 R>>'));
    assert.equal(encrypted.status, 422);
    assert.equal(encrypted.json.code, 'ENCRYPTED_PDF');
    const oversized = await post('big.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(16 * 1024 * 1024, 0x20)]));
    assert.equal(oversized.status, 413);
    const notPdf = await post('notes.txt', Buffer.from('just text'), 'text/plain');
    assert.equal(notPdf.status, 415);
    assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 0);
  });
});

test('a text-layer PDF is still read without recognition, and its per-page status says so', async () => {
  await withNothingInstalled(async () => {
    const { jsPDF } = require('jspdf');
    const doc = new jsPDF();
    [['GRN List Report page one'], ['Bill of Supply page two'], ['A third page of text']].forEach((lines, i) => {
      if (i) doc.addPage();
      lines.forEach((l, j) => doc.text(l, 10, 20 + j * 7));
    });
    const extraction = await extractPdfText(Buffer.from(doc.output('arraybuffer')));
    assert.equal(extraction.page_count, 3);
    assert.equal(extraction.source, 'text-layer');
    assert.deepEqual(extraction.diagnostics.map((d) => d.status), ['text-layer', 'text-layer', 'text-layer']);
    assert.deepEqual(extraction.diagnostics.map((d) => d.engine), ['built-in-reader', 'built-in-reader', 'built-in-reader']);
    assert.ok(extraction.diagnostics.every((d) => d.confidence === null), 'a text layer has no recognition confidence');
  });
});
