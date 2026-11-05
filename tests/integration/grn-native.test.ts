/**
 * v2.10.2 — reading a GRN PDF on a machine with nothing installed.
 *
 * The reported failure was a machine with no Poppler and no Tesseract: the wizard answered
 * "No text could be read from this PDF on this machine", "0 pages", and named three missing
 * binaries. Every test here runs with all three tools **forced absent** (the environment
 * overrides point at a path that does not exist, which the lookup treats as not-found), so what
 * passes here is what that machine gets.
 *
 * What must hold with nothing installed:
 *   1. the page count is the document's real one, never the scan limit;
 *   2. a text-layer PDF is read exactly, with no recognition at all;
 *   3. a scanned page is produced as an image, so the values can be read off it;
 *   4. the upload is accepted and answers with a complete, empty draft to type into — and still
 *      posts no purchase, payment or ledger row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readPdf, pageImage } from '../../lib/grn/pdf-native';
import { extractPdfText, availableTools, renderPage } from '../../lib/grn/extract';
import { normaliseGrnResponse } from '../../lib/grn/contract';
import * as app from '../helpers/app';

const NOWHERE = path.join(path.sep, 'solivy-no-such-tool', 'absent');
const KEYS = ['SOLIVY_PDFTOTEXT', 'SOLIVY_PDFTOPPM', 'SOLIVY_TESSERACT', 'SOLIVY_GRN_OCR_WASM_DIR'] as const;
/**
 * Run `fn` as if the machine had no poppler, no tesseract **and** no bundled OCR engine — the worst
 * case, where the pages can only be read by eye. (The bundled engine is covered by
 * `grn-ocr-bundled.test.ts`, which takes away only the installed tools.)
 */
async function withNoTools<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = KEYS.map((k) => [k, process.env[k]] as const);
  const prevPath = process.env.PATH;
  for (const k of KEYS) process.env[k] = NOWHERE;
  process.env.PATH = path.join(path.sep, 'solivy-no-such-tool');
  try { return await fn(); }
  finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
  }
}

function textPdf(pages: string[][]) {
  const { jsPDF } = require('jspdf');
  const doc = new jsPDF();
  pages.forEach((lines, i) => { if (i) doc.addPage(); lines.forEach((l, j) => doc.text(l, 10, 20 + j * 7)); });
  return Buffer.from(doc.output('arraybuffer'));
}

/** A one-page PDF whose page is a Flate-compressed RGB image — the other scan encoding. */
function flateImagePdf(width = 6, height = 4) {
  const samples = Buffer.alloc(width * height * 3);
  for (let i = 0; i < samples.length; i += 3) { samples[i] = 200; samples[i + 1] = 100; samples[i + 2] = 50; }
  const image = zlib.deflateSync(samples);
  const content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /img0 Do Q`, 'latin1');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]/Resources<</XObject<</img0 5 0 R>>>>/Contents 4 0 R>>`,
    `<</Length ${content.length}>>\nstream\n${content.toString('latin1')}\nendstream`,
    `<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${image.length}>>\nstream\n${image.toString('latin1')}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  objects.forEach((o, i) => { out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const SAMPLE = process.env.SOLIVY_GRN_SAMPLE_PDF;
const sample = SAMPLE && fs.existsSync(SAMPLE) ? fs.readFileSync(SAMPLE) : null;

// ---- the built-in reader --------------------------------------------------------------------

test('the built-in reader reports the real page count and reads every page, with no tools', async () => {
  await withNoTools(async () => {
    const doc = readPdf(textPdf([['GRN List Report page one'], ['Bill of Supply page two'], ['A third page']]));
    assert.equal(doc.ok, true);
    assert.equal(doc.pageCount, 3, 'the page tree, not a guess');
    assert.equal(doc.pages.length, 3);
    assert.match(doc.pages[0].text, /GRN List Report page one/);
    assert.match(doc.pages[1].text, /Bill of Supply page two/);
    assert.match(doc.pages[2].text, /A third page/);
    assert.ok(Math.abs(doc.pages[0].width - 595.28) < 0.5, `A4 width in points, from the MediaBox: ${doc.pages[0].width}`);
  });
});

test('a one-page document is reported as one page', async () => {
  await withNoTools(() => assert.equal(readPdf(textPdf([['Only page']])).pageCount, 1));
});

test('a Flate-compressed page image is produced as a valid PNG, with no tools', async () => {
  await withNoTools(async () => {
    const doc = readPdf(flateImagePdf(), { withImages: true });
    assert.equal(doc.pageCount, 1);
    assert.equal(doc.pages[0].images.length, 1);
    const img = doc.pages[0].images[0];
    assert.equal(img.mime, 'image/png');
    assert.equal(img.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the PNG signature');
    assert.equal(img.bytes.subarray(12, 16).toString('latin1'), 'IHDR');
    assert.equal(img.bytes.readUInt32BE(16), 6, 'the declared width');
    assert.equal(img.bytes.readUInt32BE(20), 4, 'the declared height');
  });
});

test('a password-protected or damaged PDF is named rather than read', async () => {
  await withNoTools(async () => {
    const locked = readPdf(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Encrypt 2 0 R/Root 1 0 R>>'));
    assert.equal(locked.encrypted, true);
    assert.match(locked.note, /password-protected/i);
    const damaged = readPdf(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(512, 0x41)]));
    assert.equal(damaged.ok, false);
    assert.equal(damaged.pageCount, 0);
    assert.match(damaged.note, /No pages|damaged/i);
    assert.equal(readPdf(Buffer.from('not a pdf at all')).ok, false);
  });
});

// ---- extraction with nothing installed ------------------------------------------------------

test('with no tools at all, a text-layer PDF is still read in full and needs no recognition', async () => {
  await withNoTools(async () => {
    const tools = availableTools();
    assert.deepEqual(tools, { pdftotext: null, pdftoppm: null, tesseract: null }, 'the test really has no tools');
    const extraction = await extractPdfText(textPdf([['GRN List Report page one of this document'], ['Bill of Supply page two of this document'], ['A third page with its own paragraph']]));
    assert.equal(extraction.page_count, 3);
    assert.equal(extraction.pages.length, 3);
    assert.equal(extraction.source, 'text-layer');
    assert.equal(extraction.native, true);
    assert.ok(extraction.pages.every((p) => p.source === 'text-layer'));
    assert.ok(!extraction.notes.some((n) => /tesseract|pdftoppm/i.test(n)), `no tool is demanded: ${extraction.notes.join(' | ')}`);
    assert.ok(extraction.notes.some((n) => /built-in reader/i.test(n)), 'and it says how it was read');
  });
});

test('the page count is never the scan limit: an unreadable page is counted, not invented', async () => {
  await withNoTools(async () => {
    const extraction = await extractPdfText(flateImagePdf());
    assert.equal(extraction.page_count, 1, 'one page — the earlier build reported the 20-page default here');
    assert.equal(extraction.pages.length, 0, 'and claims no text was read');
    assert.deepEqual(extraction.viewable_pages, [1], 'but the page can be shown');
  });
});

test('a scan with no recognition engine names only what is actually missing, and offers the pages', { skip: sample ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the supplied document' }, async () => {
  await withNoTools(async () => {
    const extraction = await extractPdfText(sample!);
    assert.equal(extraction.page_count, 2, 'the real count of the supplied scan');
    assert.equal(extraction.pages.length, 0, 'nothing could be read, and nothing is claimed');
    assert.deepEqual(extraction.viewable_pages, [1, 2], 'both pages can be shown');
    const note = extraction.notes.join(' | ');
    assert.match(note, /2 of 2 page\(s\)/, `the real figure, not the scan limit: ${note}`);
    assert.match(note, /Tesseract/i, 'the one tool that would help is named');
    assert.ok(!/pdftotext|pdftoppm/i.test(note), `poppler is no longer demanded: ${note}`);
    assert.match(note, /shown here at full scanner resolution/i, 'and the way forward is stated');
  });
});

test('a scanned page is produced as an image with no tools, straight out of the file', { skip: sample ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the supplied document' }, async () => {
  await withNoTools(async () => {
    for (const page of [1, 2]) {
      const img = renderPage(sample!, page);
      assert.ok(img, `page ${page} is produced`);
      assert.equal(img!.mime, 'image/jpeg');
      assert.equal(img!.bytes.subarray(0, 2).toString('hex'), 'ffd8', `page ${page} carries the JPEG signature`);
      assert.ok(img!.bytes.length > 50_000, `page ${page} is the full-resolution scan (${img!.bytes.length} bytes)`);
    }
    assert.equal(renderPage(sample!, 9), null, 'a page that does not exist yields nothing, not an error');
    assert.ok(pageImage(sample!, 1), 'and the same through the reader directly');
  });
});

test('recognition needs Tesseract alone: the page image no longer comes from poppler', { skip: sample && availableTools().tesseract ? false : 'NOT VERIFIED: needs the sample and tesseract' }, async () => {
  const previous = process.env.SOLIVY_PDFTOPPM;
  const prevText = process.env.SOLIVY_PDFTOTEXT;
  const prevEngine = process.env.SOLIVY_GRN_OCR_ENGINE;
  process.env.SOLIVY_PDFTOPPM = NOWHERE;            // poppler absent, tesseract present
  process.env.SOLIVY_PDFTOTEXT = NOWHERE;
  process.env.SOLIVY_GRN_OCR_ENGINE = 'system';     // this test is about the installed binary
  try {
    const extraction = await extractPdfText(sample!);
    assert.equal(extraction.page_count, 2);
    assert.equal(extraction.pages.length, 2, 'both pages were recognised with no poppler at all');
    assert.equal(extraction.engine.kind, 'system-tesseract');
    assert.equal(extraction.source, 'ocr');
    // The embedded image is the scanner's own, with no resolution recorded in it, so the page
    // geometry is used to tell recognition the scale. Every printed field must still come through.
    const parsed = require('../../lib/grn/parse').parseDocument(extraction.pages.map((p: any) => ({ page: p.page, text: p.text })));
    assert.ok(parsed.grn, 'the GRN page is recognised with no poppler');
    assert.equal(parsed.grn.sample_no.value, '2627-22603');
    assert.equal(parsed.grn.net_weight_kg.value, 21262);
    assert.equal(parsed.grn.bags.value, 375);
    assert.equal(parsed.grn.moisture_percent.value, 11.5);
    assert.ok(parsed.bill, 'and so is the party bill');
    assert.equal(parsed.bill.invoice_no.value, '274');
    assert.equal(parsed.bill.total_amount.value, 437800);
    assert.equal(parsed.bill.vehicle_no.value, 'GJ04X5630');
  } finally {
    if (previous === undefined) delete process.env.SOLIVY_PDFTOPPM; else process.env.SOLIVY_PDFTOPPM = previous;
    if (prevText === undefined) delete process.env.SOLIVY_PDFTOTEXT; else process.env.SOLIVY_PDFTOTEXT = prevText;
    if (prevEngine === undefined) delete process.env.SOLIVY_GRN_OCR_ENGINE; else process.env.SOLIVY_GRN_OCR_ENGINE = prevEngine;
  }
});

// ---- the endpoint and the contract ----------------------------------------------------------

test('a scan with no engine of any kind is accepted for manual entry, and posts nothing', { skip: sample ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the supplied document' }, async () => {
  const session = await app.adminSession('LIVE');
  const keys = KEYS;   // includes SOLIVY_GRN_OCR_WASM_DIR: no installed tools AND no bundled engine
  const previous = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) process.env[k] = NOWHERE;
  try {
    const body = new FormData();
    body.append('file', new File([new Uint8Array(sample!)], 'grn.pdf', { type: 'application/pdf' }));
    const r = await app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
    assert.equal(r.status, 200, r.text);
    const n = normaliseGrnResponse(r.json, r.status);

    assert.equal(n.ok, true, 'the upload is no longer a dead end');
    assert.equal(n.manual_entry, true, 'and is marked as one to type in');
    assert.equal(n.extraction.page_count, 2);
    assert.deepEqual(n.extraction.viewable_pages, [1, 2]);
    assert.equal(n.extraction.source, 'none', 'no text was read, and none is claimed');
    assert.equal(n.recognised.grn, false);
    assert.equal(n.recognised.bill, false);
    assert.equal(n.original_kept, true, 'the document is kept so its pages can be shown');

    // A complete, empty draft: every field present, nothing invented.
    for (const k of ['sample_no', 'truck_number', 'net_weight', 'rate', 'moisture']) assert.ok(k in n.draft.purchase, `${k} is present`);
    assert.equal(n.draft.purchase.net_weight, 0);
    assert.equal(n.draft.purchase.rate, 0);
    assert.equal(n.draft.purchase.sample_no, '');
    assert.equal(n.draft.calculation.net_payable, 0, 'and the calculation is sound on an empty draft');
    const blocking = n.draft.warnings.filter((w) => w.severity === 'blocking').map((w) => w.code);
    assert.ok(blocking.includes('PARTY_REQUIRED') && blocking.includes('REQUIRED_FIELDS'), `what must be entered is stated: ${blocking.join(', ')}`);

    // The pages really are servable from the stored copy.
    const img = await app.call('/api/grn', { cookie: session.cookie, query: { id: n.document_id, page: 1 } });
    assert.equal(img.status, 200, img.text);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(img.buffer.subarray(0, 2).toString('hex'), 'ffd8');

    // Nothing was posted.
    const data = app.expectOk(await app.call('/api/data', { cookie: session.cookie }));
    assert.equal(data.purchases.length, 0, 'no purchase');
    assert.equal((data.payments || []).length, 0, 'no payment');
  } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('a PDF with no pages at all is still refused, with its own reason', async () => {
  const session = await app.adminSession('LIVE');
  const body = new FormData();
  body.append('file', new File([new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024, 0x41)]))], 'damaged.pdf', { type: 'application/pdf' }));
  const r = await app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
  assert.equal(r.status, 422, r.text);
  assert.match(String(r.json.error), /no pages were found/i);
  assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 0);
});

test('a text-layer PDF imports with no tools through the endpoint, and is not marked manual', async () => {
  const session = await app.adminSession('LIVE');
  const keys = KEYS;   // includes SOLIVY_GRN_OCR_WASM_DIR: no installed tools AND no bundled engine
  const previous = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) process.env[k] = NOWHERE;
  try {
    const pdf = textPdf([['GRN List Report'], ['Bill of Supply']]);
    const body = new FormData();
    body.append('file', new File([new Uint8Array(pdf)], 'text.pdf', { type: 'application/pdf' }));
    const r = await app.call('/api/grn', { method: 'POST', cookie: session.cookie, body });
    assert.equal(r.status, 200, r.text);
    const n = normaliseGrnResponse(r.json, r.status);
    assert.equal(n.manual_entry, false, 'text was read, so this is a normal review');
    assert.equal(n.extraction.page_count, 2);
    assert.equal(n.extraction.source, 'text-layer');
    assert.equal(n.extraction.native, true);
    assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 0);
  } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the normaliser carries the manual-entry fields and defaults them safely', () => {
  const bare = normaliseGrnResponse({ ok: true, draft: { purchase: {} } }, 200);
  assert.equal(bare.manual_entry, false);
  assert.deepEqual(bare.extraction.viewable_pages, []);
  assert.equal(bare.extraction.native, false);
  const manual = normaliseGrnResponse({ ok: true, manual_entry: true, draft: { purchase: {} }, extraction: { page_count: 2, viewable_pages: [1, 2, 0, -3], native: true } }, 200);
  assert.equal(manual.manual_entry, true);
  assert.deepEqual(manual.extraction.viewable_pages, [1, 2], 'page numbers below one are dropped');
  assert.equal(manual.extraction.native, true);
});
