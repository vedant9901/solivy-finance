/**
 * v2.10.1 — the /api/grn response contract.
 *
 * Regression tests for the reported crash
 * (`Cannot read properties of undefined (reading 'calculation')`): the screen assumed a shape the
 * endpoint does not always return. Every response now normalises to one shape, and a response
 * that is missing something says so instead of being filled in with plausible figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseGrnResponse, normalisePurchase, calculationFor, emptyDraft, blockingReasons, PURCHASE_NUMBERS } from '../../lib/grn/contract';
import { purchaseCalc } from '../../lib/utils';

test('a response that is undefined, null or not an object still yields a usable draft', () => {
  for (const raw of [undefined, null, '', 0, 'not json', []]) {
    const r = normaliseGrnResponse(raw as any, 200);
    assert.equal(r.ok, false);
    assert.equal(r.complete, false);
    assert.ok(r.problems.length > 0, `problems are reported for ${JSON.stringify(raw)}`);
    assert.equal(typeof r.draft.calculation.net_payable, 'number', 'a calculation is always present');
    assert.equal(r.draft.calculation.net_payable, 0, 'and it is zero, not an invented figure');
    assert.deepEqual(r.draft.warnings, []);
    assert.deepEqual(r.draft.duplicates, []);
    assert.equal(r.extraction.page_count, 0);
  }
});

test('the failure shape the endpoint really returns — extraction present, no draft — does not crash', () => {
  // This is the response that produced the reported error.
  const raw = { ok: false, error: 'No text could be read from this PDF on this machine.', extraction: { source: 'none', page_count: 2, notes: ['tesseract was not found.'], tools: { tesseract: null }, pages: [] } };
  const r = normaliseGrnResponse(raw, 422);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'No text could be read from this PDF on this machine.');
  assert.ok(r.problems.some((p) => /no draft purchase/i.test(p)));
  assert.equal(r.extraction.page_count, 2);
  assert.deepEqual(r.extraction.notes, ['tesseract was not found.']);
  // The access that used to throw:
  assert.equal(r.draft.calculation.discount_after_quality, 1);
  assert.doesNotThrow(() => calculationFor(r.draft.purchase, r.draft.calculation.discount_after_quality));
});

test('a draft with no calculation is recomputed rather than rejected, and says so', () => {
  const raw = { ok: true, document_id: 7, draft: { purchase: { net_weight: 1000, rate: 20, discount_pct: 1 } } };
  const r = normaliseGrnResponse(raw, 200);
  assert.ok(r.problems.some((p) => /no calculation/i.test(p)));
  assert.equal(r.draft.calculation.gross_amount, 20000);
  assert.equal(r.draft.calculation.net_payable, purchaseCalc({ net_weight: 1000, rate: 20, discount_pct: 1, discount_after_quality: 1 }).net_payable);
  assert.equal(r.complete, false, 'the gap is reported even though the screen can render');
});

test('a partial draft is completed with zeros and empty strings, never with values', () => {
  const r = normaliseGrnResponse({ ok: true, draft: { purchase: { sample_no: 'S-1', rate: '20.5', bags_qty: 'not a number' } } }, 200);
  assert.equal(r.draft.purchase.sample_no, 'S-1');
  assert.equal(r.draft.purchase.rate, 20.5, 'a numeric string becomes a number');
  assert.equal(r.draft.purchase.bags_qty, 0, 'an unusable number becomes 0');
  assert.equal(r.draft.purchase.net_weight, 0);
  assert.equal(r.draft.purchase.truck_number, '');
  assert.equal(r.draft.purchase.party_id, null);
  assert.equal(r.draft.purchase.gst_type, 'NONE');
  for (const k of PURCHASE_NUMBERS) assert.equal(typeof r.draft.purchase[k], 'number', `${k} is numeric`);
});

test('malformed warnings, duplicates and evidence cannot break the screen', () => {
  const r = normaliseGrnResponse({ ok: true, draft: { purchase: {}, warnings: ['a string', null, { message: 'no code' }, { code: 'X', severity: 'nonsense', message: 'bad severity' }], duplicates: 'not an array', evidence: 42 } }, 200);
  assert.equal(r.draft.warnings.length, 2);
  assert.equal(r.draft.warnings[0].code, 'WARNING');
  assert.equal(r.draft.warnings[1].severity, 'review', 'an unknown severity falls back to review');
  assert.deepEqual(r.draft.duplicates, []);
  assert.deepEqual(r.draft.evidence, {});
});

test('a complete successful response passes through unchanged and is marked complete', () => {
  const raw = {
    ok: true, document_id: 3, file_name: 'grn.pdf', original_kept: true,
    extraction: { source: 'ocr', page_count: 2, notes: [], tools: {}, pages: [{ page: 1, source: 'ocr' }, { page: 2, source: 'ocr' }] },
    recognised: { grn: true, bill: true, grn_page: 1, bill_page: 2, unrecognised_pages: [] },
    link: { linked: true, confidence: 'high', reasons: ['vehicle matches'] },
    draft: {
      purchase: { sample_no: '2627-22603', purchase_date: '2026-10-17', truck_number: 'GJ04X5630', net_weight: 21262, gross_weight: 21890, rate: 20, party_id: 4 },
      calculation: { ...purchaseCalc({ net_weight: 21262, rate: 20, discount_after_quality: 1 }), discount_after_quality: 1 },
      party: { matched: true, party_id: 4, party_name: 'Deepak Enterprises', method: 'GSTIN', confidence: 'high', candidates: [], draft: null, bank_draft: null },
      broker: { name: 'Shyam Broker', party_id: null, matched: false },
      warnings: [{ code: 'RATE_CONVERTED', severity: 'info', message: 'per quintal' }], duplicates: [], evidence: { 'grn.net_weight_kg': { value: 21262, confidence: 'medium' } },
    },
  };
  const r = normaliseGrnResponse(raw, 200);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.draft.purchase.net_weight, 21262);
  assert.equal(r.draft.calculation.gross_amount, 425240);
  assert.equal(r.recognised.grn_page, 1);
  assert.equal(r.recognised.bill_page, 2);
  assert.equal(r.draft.party.party_name, 'Deepak Enterprises');
});

test('an HTTP error with no body still produces a draft and an explanation', () => {
  const r = normaliseGrnResponse(null, 500);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /HTTP 500/);
  assert.equal(r.draft.purchase.rate, 0);
});

test('the empty draft and the blocking list agree about what is missing', () => {
  const d = emptyDraft();
  assert.deepEqual(blockingReasons(d.purchase).sort(), [
    'Choose or create the party.', 'Enter the net weight.', 'Enter the purchase date.', 'Enter the rate per kg.', 'Enter the vehicle number.',
  ]);
  assert.deepEqual(blockingReasons(normalisePurchase({ party_id: 4, purchase_date: '2026-10-17', net_weight: 1, rate: 1, truck_number: 'GJ01AA1111' })), []);
});

// ---- document-shape handling, with real PDFs built in the test --------------------------------
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractPdfText, availableTools } from '../../lib/grn/extract';
import { parseDocument } from '../../lib/grn/parse';
import * as app from '../helpers/app';

/** A real text-layer PDF, built with the jsPDF already in this project. */
function textPdf(pages: string[][]) {
  const { jsPDF } = require('jspdf');
  const doc = new jsPDF();
  pages.forEach((lines, i) => { if (i) doc.addPage(); lines.forEach((l, j) => doc.text(l, 10, 20 + j * 7)); });
  return Buffer.from(doc.output('arraybuffer'));
}

test('a text-layer PDF is read without recognition, and every page is processed', async () => {
  const tools = availableTools();
  if (!tools.pdftotext) { assert.ok(true, 'NOT VERIFIED: pdftotext is not installed here'); return; }
  const pdf = textPdf([['GRN List Report page one of this document'], ['Bill of Supply page two of this document'], ['A third page with its own paragraph of text']]);
  const extraction = await extractPdfText(pdf);
  assert.equal(extraction.page_count, 3, 'the whole document is counted, not just page 1');
  assert.equal(extraction.pages.length, 3);
  assert.equal(extraction.source, 'text-layer', 'no recognition was needed');
  assert.match(extraction.pages[2].text, /A third page/);
});

test('pages that are neither a GRN nor a party bill are reported, not silently ignored', () => {
  const grnText = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'grn', 'sayaji-grn-page1.ocr.txt'), 'utf8');
  const billText = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'grn', 'party-bill-page2.ocr.txt'), 'utf8');
  const parsed = parseDocument([
    { page: 1, text: grnText }, { page: 2, text: billText },
    { page: 3, text: 'A weighbridge slip in some other layout entirely' },
    { page: 4, text: 'A second party bill that this build does not import' },
  ]);
  assert.equal(parsed.grn_page, 1);
  assert.equal(parsed.bill_page, 2);
  assert.deepEqual(parsed.unrecognised_pages, [3, 4], 'both extra pages are named');
});

test('a missing recognition engine is named instead of producing an empty document', async () => {
  // v2.11.0: the engine ships with SOLIVY, so both it and any system Tesseract are taken away here.
  const previous = { t: process.env.SOLIVY_TESSERACT, w: process.env.SOLIVY_GRN_OCR_WASM_DIR };
  process.env.SOLIVY_TESSERACT = path.join(os.tmpdir(), 'no-such-tesseract-binary');
  process.env.SOLIVY_GRN_OCR_WASM_DIR = path.join(os.tmpdir(), 'no-such-ocr-engine');
  try {
    // A PDF with no text layer: jsPDF with no text at all gives an empty page.
    const { jsPDF } = require('jspdf');
    const doc = new jsPDF(); doc.addPage();
    const extraction = await extractPdfText(Buffer.from(doc.output('arraybuffer')));
    assert.equal(extraction.engine.kind, 'none');
    assert.ok(/bundled OCR engine is missing/i.test(String(extraction.engine.reason)), `the engine problem is named: ${extraction.engine.reason}`);
    assert.ok(extraction.notes.some((n) => /SOLIVY_GRN_OCR_WASM_DIR|Reinstall SOLIVY/i.test(n)), `and how to fix it is stated: ${extraction.notes.join(' | ')}`);
  } finally {
    if (previous.t === undefined) delete process.env.SOLIVY_TESSERACT; else process.env.SOLIVY_TESSERACT = previous.t;
    if (previous.w === undefined) delete process.env.SOLIVY_GRN_OCR_WASM_DIR; else process.env.SOLIVY_GRN_OCR_WASM_DIR = previous.w;
  }
});

test('corrupt, encrypted, oversized and non-PDF uploads are each refused with their own reason', async () => {
  const session = await app.adminSession('LIVE');
  const post = async (name: string, bytes: Buffer, type = 'application/pdf') => {
    const body = new FormData();
    body.append('file', new File([new Uint8Array(bytes)], name, { type }));
    return app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
  };
  const notPdf = await post('notes.txt', Buffer.from('just text'), 'text/plain');
  assert.equal(notPdf.status, 415, notPdf.text);
  assert.match(String(notPdf.json.error), /not a PDF/i);

  const empty = await post('empty.pdf', Buffer.alloc(0));
  assert.equal(empty.status, 400, empty.text);

  const encrypted = await post('locked.pdf', Buffer.from('%PDF-1.4\n1 0 obj<</Encrypt 2 0 R>>endobj\ntrailer<</Encrypt 2 0 R>>'));
  assert.equal(encrypted.status, 422, encrypted.text);
  assert.equal(encrypted.json.code, 'ENCRYPTED_PDF');
  assert.match(String(encrypted.json.error), /password-protected/i);

  const corrupt = await post('corrupt.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x41)]));
  assert.ok([422, 200].includes(corrupt.status), corrupt.text);
  if (corrupt.status === 422) assert.ok(String(corrupt.json.error).length > 0, 'a reason is given');
  else assert.equal(corrupt.json.recognised.grn, false, 'nothing is claimed to be recognised');

  const oversized = await post('big.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(16 * 1024 * 1024, 0x20)]));
  assert.equal(oversized.status, 413, oversized.text);
  assert.match(String(oversized.json.error), /limit is 15 MB/);

  // None of these created an accounting entry.
  assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 0);
});
