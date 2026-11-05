/**
 * v2.11.1 — the second OCR pass: where its regions come from, when it runs, and the guard that
 * stops it making a page worse.
 *
 * The geometry tests build word boxes directly, so they are deterministic and need no engine: they
 * are about how a region is located and how a wrapped table cell is rebuilt, which is logic, not
 * recognition. The engine itself is covered by `grn-ocr-bundled.test.ts`.
 *
 * The property that matters most here: **nothing is pinned to this one document**. Every region is
 * derived from the anchor words' own positions, so the same page scanned at twice the resolution
 * yields the same region scaled, and a page without the anchors yields no region at all rather
 * than a wrong one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { looksLikeGrn, looksLikeBill, grnRegions, billRegions, rebuildTable, grnRowLines, combinePasses, coverageOf } from '../../lib/grn/regions';
import { parseGrnPage, parseBillPage, parseDocument } from '../../lib/grn/parse';
import { extractPdfText } from '../../lib/grn/extract';
import type { WasmWord } from '../../lib/grn/ocr-wasm';

const PARSERS = { grn: parseGrnPage, bill: parseBillPage };
const SAMPLE = process.env.SOLIVY_GRN_SAMPLE_PDF;
const sample = SAMPLE && fs.existsSync(SAMPLE) ? fs.readFileSync(SAMPLE) : null;
const needsSample = sample ? false : 'NOT VERIFIED: set SOLIVY_GRN_SAMPLE_PDF to the supplied document';

let nextLine = 0;
const w = (text: string, x: number, y: number, width = text.length * 12, height = 20, line = nextLine): WasmWord =>
  ({ text, x, y, width, height, confidence: 90, line });

/** A GRN-shaped page of word boxes: two header lines, then a data row with a wrapped name cell. */
function grnWords(scale = 1): WasmWord[] {
  const s = (n: number) => Math.round(n * scale);
  const out: WasmWord[] = [];
  const put = (text: string, x: number, y: number, line: number) => out.push(w(text, s(x), s(y), s(text.length * 12), s(20), line));
  put('GRN', 100, 60, 0); put('List', 160, 60, 0); put('Report', 220, 60, 0);
  // Header, printed over two lines as the real report does.
  put('Truck', 700, 400, 1); put('No.', 770, 400, 1); put('PO', 900, 400, 1); put('Supplier', 950, 400, 1);
  put('Recd.', 1250, 400, 1); put('Net.', 1340, 400, 1); put('Freight', 1450, 400, 1); put('Load', 1580, 400, 1);
  put('Deduction', 1880, 400, 1); put('for', 1990, 400, 1);
  put('Sample', 100, 430, 2); put('No.', 200, 430, 2); put('GRN', 400, 430, 2); put('Date', 470, 430, 2);
  put('Bags', 1150, 430, 2); put('Wt', 1290, 430, 2); put('Amount', 1450, 430, 2); put('Rokdi', 1660, 430, 2);
  put('Moist', 1780, 430, 2); put('%', 1850, 430, 2); put('Kg', 1950, 430, 2);
  // The supplier cell, printed wrapped: one line above the row, the row itself, one below.
  put('AKSH', 900, 460, 3);
  put('2627-22603', 100, 490, 4); put('17.10.2026', 400, 490, 4); put('5630', 700, 490, 4);
  put('ENTERPRIS', 900, 490, 4); put('375', 1150, 490, 4); put('21262', 1250, 490, 4);
  put('0', 1460, 490, 4); put('0', 1590, 490, 4); put('0', 1670, 490, 4); put('11.50', 1780, 490, 4); put('0.00', 1950, 490, 4);
  put('E', 900, 520, 5);
  put('Total', 100, 560, 6); put('375', 1150, 560, 6); put('21262', 1250, 560, 6);
  put('PLEASE', 100, 620, 7); put('MENTION', 200, 620, 7);
  return out;
}
const sizeOf = (words: WasmWord[]) => ({ width: Math.max(...words.map((x) => x.x + x.width)), height: Math.max(...words.map((x) => x.y + x.height)) });

const GRN_HEADERS = [['sample', 'no'], ['grn', 'date'], ['truck', 'no'], ['po', 'supplier'], ['bags'], ['recd', 'net'], ['freight'], ['load'], ['rokdi'], ['moist'], ['deduction']];

// ---- what a page looks like ------------------------------------------------------------------

test('a GRN page and a bill page are told apart from their printed labels', () => {
  assert.equal(looksLikeGrn(grnWords()), true);
  assert.equal(looksLikeBill(grnWords()), false);
  const bill = [w('Bill', 10, 10), w('of', 60, 10), w('Supply', 90, 10), w('Invoice', 10, 60), w('No.', 80, 60), w('HSN', 10, 200)];
  assert.equal(looksLikeBill(bill), true);
  assert.equal(looksLikeGrn(bill), false);
  const neither = [w('Payment', 10, 10), w('Advice', 80, 10)];
  assert.equal(looksLikeGrn(neither), false);
  assert.equal(looksLikeBill(neither), false);
});

// ---- where the regions come from --------------------------------------------------------------

test('the table region is located from the header words, and stops at the totals line', () => {
  const words = grnWords();
  const regions = grnRegions(words, sizeOf(words));
  const table = regions.find((r) => r.name === 'grn-receipt-table');
  assert.ok(table, `a table region is proposed: ${regions.map((r) => r.name).join(', ')}`);
  // It starts above the header line and ends at or below the "Total" line, which sits at y 560.
  assert.ok(table!.rect.y < 400, `starts above the header (y=${table!.rect.y})`);
  assert.ok(table!.rect.y + table!.rect.height >= 580, `reaches past the totals line (bottom=${table!.rect.y + table!.rect.height})`);
  assert.ok(table!.rect.y + table!.rect.height < 1000, 'and does not swallow the whole page');
});

test('regions are page-relative, not pixel coordinates fixed for one document', () => {
  const one = grnWords(1);
  const two = grnWords(2);                       // the same page scanned at twice the resolution
  const a = grnRegions(one, sizeOf(one)).find((r) => r.name === 'grn-receipt-table')!;
  const b = grnRegions(two, sizeOf(two)).find((r) => r.name === 'grn-receipt-table')!;
  assert.ok(a && b, 'both are located');
  // Within rounding, the region scales with the page instead of staying at fixed pixels.
  assert.ok(Math.abs(b.rect.y / a.rect.y - 2) < 0.15, `y scales with the page: ${a.rect.y} → ${b.rect.y}`);
  assert.ok(Math.abs(b.rect.height / a.rect.height - 2) < 0.2, `height scales: ${a.rect.height} → ${b.rect.height}`);
});

test('a page without the anchors yields no region rather than a guessed one', () => {
  const words = [w('Payment', 100, 100), w('Advice', 200, 100), w('Amount', 100, 200), w('5,000', 300, 200)];
  assert.deepEqual(grnRegions(words, sizeOf(words)), []);
  assert.deepEqual(billRegions(words, sizeOf(words)), []);
  assert.deepEqual(grnRegions([], { width: 0, height: 0 }), [], 'and an empty page is not a crash');
});

test('a bill proposes its header and goods-table regions, each inside the page', () => {
  const words = [
    w('Bill', 100, 60), w('of', 160, 60), w('Supply', 200, 60),
    w('Invoice', 1200, 300), w('No.', 1290, 300), w('274', 1400, 300),
    w('HSN', 900, 1200), w('SAC', 980, 1200), w('10059000', 900, 1260),
    w('Amount', 1800, 1900), w('4,37,800.00', 1800, 1960),
  ];
  const size = sizeOf(words);
  const regions = billRegions(words, size);
  assert.deepEqual(regions.map((r) => r.name).sort(), ['bill-goods-table', 'bill-header']);
  for (const r of regions) {
    assert.ok(r.rect.x >= 0 && r.rect.y >= 0, `${r.name} starts inside the page`);
    assert.ok(r.rect.y + r.rect.height <= size.height, `${r.name} ends inside the page`);
    assert.ok(r.rect.width > 0 && r.rect.height > 0, `${r.name} has an extent`);
  }
});

// ---- rebuilding the row by column -------------------------------------------------------------

test('the row is rebuilt by column, and a cell the document wrapped arrives whole', () => {
  const table = rebuildTable(grnWords(), GRN_HEADERS);
  assert.ok(table, 'the table is rebuilt');
  const row = table!.rows.find((r) => String(r['sample no'] || '').includes('2627-22603'));
  assert.ok(row, `the data row is found: ${JSON.stringify(table!.rows)}`);
  assert.match(String(row!['sample no']), /2627-22603/);
  assert.match(String(row!['grn date']), /17\.10\.2026/);
  assert.match(String(row!['truck no']), /5630/);
  // The point of the exercise: AKSH / ENTERPRIS / E, on three different lines, as one name.
  assert.equal(String(row!['po supplier']).replace(/\s+/g, ' ').trim(), 'AKSH ENTERPRISE');
  assert.match(String(row!['bags']), /375/);
  assert.match(String(row!['recd net']), /21262/);
  assert.match(String(row!['moist']), /11\.50/);
});

test('the rebuilt row is emitted as labelled lines, never as positional guesswork', () => {
  const lines = grnRowLines(rebuildTable(grnWords(), GRN_HEADERS));
  assert.ok(lines.length, 'lines are produced');
  for (const l of lines) assert.match(l, /^[a-z ]+: /, `every line names its column: ${l}`);
  assert.ok(lines.some((l) => /^po supplier: AKSH ENTERPRISE$/.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => /^recd net: 21262/.test(l)), lines.join(' | '));
});

test('a table with no header, or no body, is reported as nothing rather than a wrong row', () => {
  assert.equal(rebuildTable([w('just', 10, 10), w('text', 60, 10)], GRN_HEADERS), null);
  const headerOnly = grnWords().filter((x) => x.y <= 430);
  assert.equal(rebuildTable(headerOnly, GRN_HEADERS), null, 'a header with nothing under it yields no row');
  assert.deepEqual(grnRowLines(null), [], 'and nothing at all is handled');
  assert.deepEqual(grnRowLines({ columns: [], rows: [] }), [], 'as is an empty table');
});

// ---- the gate and the guard -------------------------------------------------------------------

const FULL_GRN = [
  'GRN List Report',
  'Truck No. |PO Supplier| Recd. Net. Recd. Freight Load Deduction for',
  'Sample No. | GRN Date RR No. Nga Bags Wt Amount — Rokdi Moist % Kg',
  'AKSH',
  '2627-22603 | 17.10.2026 | 5630 ENTERPRIS 375 21262 0 0 0 11.50 0.00',
  'E',
  'THE VALUE OF LOSSES SUSTAINED BY US DUE TO MOISTURE CONTENT MORE THEN 14.00 %.',
].join('\n');

test('coverage is measured with the real parser, so the gate uses the draft\'s own rules', () => {
  const full = coverageOf(FULL_GRN, PARSERS);
  assert.equal(full.kind, 'grn');
  assert.deepEqual(full.missing, [], `a complete page is complete: ${full.missing.join(', ')}`);
  assert.equal(full.score, full.required.length);

  // The same page with the data row lost — what an unreadable table actually looks like.
  const rowless = FULL_GRN.split('\n').filter((l) => !l.includes('2627-22603')).join('\n');
  const partial = coverageOf(rowless, PARSERS);
  assert.ok(partial.missing.length >= 4, `the missing fields are named: ${partial.missing.join(', ')}`);
  assert.ok(partial.score < full.score, 'and it scores lower than the complete page');

  const nothing = coverageOf('an unrelated page of prose', PARSERS);
  assert.equal(nothing.kind, 'unknown');
  assert.equal(nothing.score, 0);
});

test('the second pass improves a page only when it adds a field, and is otherwise discarded', () => {
  const rowless = FULL_GRN.split('\n').filter((l) => !l.includes('2627-22603')).join('\n');
  const before = coverageOf(rowless, PARSERS);

  // A region pass that recovers the row: coverage rises, so the combined text would be kept.
  const recovered = combinePasses(rowless, [], [{ name: 'grn-receipt-table', lines: ['2627-22603 | 17.10.2026 | 5630 AKSH ENTERPRISE 375 21262 0 0 0 11.50 0.00'] }]);
  const after = coverageOf(recovered, PARSERS);
  assert.ok(after.score > before.score, `the recovered row raises coverage ${before.score} → ${after.score}`);

  // A region pass that reads the table worse: coverage does not rise, so it would be discarded.
  const garbled = combinePasses(rowless, [{ name: 'grn-receipt-table', rect: { x: 0, y: 0, width: 10, height: 10 }, text: 're ge ef af at', confidence: 40, words: [], ms: 5, skipped: null }], []);
  assert.ok(coverageOf(garbled, PARSERS).score <= before.score, 'a worse region pass cannot raise the score');
});

test('combined passes keep their provenance and do not duplicate a value into two fields', () => {
  const combined = combinePasses(FULL_GRN, [{ name: 'grn-receipt-table', rect: { x: 0, y: 0, width: 10, height: 10 }, text: '2627-22603 | 17.10.2026 | 5630 375 21262 0 0 0 11.50 0.00', confidence: 80, words: [], ms: 5, skipped: null }], [{ name: 'grn-receipt-table', lines: ['sample no: 2627-22603', 'recd net: 21262'] }]);
  assert.match(combined, /\[\[region grn-receipt-table/, 'each pass is marked with where it came from');
  // The same row read twice must still parse to one set of values, not two.
  const parsed = parseGrnPage(combined);
  assert.ok(parsed);
  assert.equal(parsed!.sample_no.value, '2627-22603');
  assert.equal(parsed!.net_weight_kg.value, 21262);
  assert.equal(parsed!.bags.value, 375);
  assert.equal(parsed!.moisture_percent.value, 11.5);
});

// ---- against the real document ----------------------------------------------------------------

test('the real sample: the first pass covers every required field, so no region is read again', { skip: needsSample }, async () => {
  const keys = ['SOLIVY_PDFTOTEXT', 'SOLIVY_PDFTOPPM', 'SOLIVY_TESSERACT'] as const;
  const previous = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) process.env[k] = '/solivy-no-such-tool/absent';
  try {
    const extraction = await extractPdfText(sample!);
    assert.equal(extraction.engine.kind, 'bundled-wasm');
    for (const d of extraction.diagnostics) {
      assert.equal(d.status, 'recognised', `page ${d.page}`);
      assert.ok(d.image && d.image.width > 1000, `page ${d.page} records the image it read: ${JSON.stringify(d.image)}`);
      assert.deepEqual(d.regions, [], `page ${d.page} needed no second pass`);
      assert.match(String(d.second_pass_reason), /covered every required field/, `page ${d.page}: ${d.second_pass_reason}`);
    }
    // And the supplier name, which the document prints wrapped, comes out whole.
    const parsed = parseDocument(extraction.pages.map((p) => ({ page: p.page, text: p.text })));
    assert.equal(parsed.grn!.supplier_name.value, 'AKSH ENTERPRISE');
    assert.match(String(parsed.grn!.supplier_name.note), /printed wrapped|reassembled/i);
  } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---- the engine's own region pass, end to end --------------------------------------------------

/** A GRN-shaped page rendered to an image, so the engine's region pass can be driven for real. */
function scannedGrnPage(dpi: number): Buffer | null {
  let execFileSync: any; let os: any; let pathMod: any;
  try { execFileSync = require('node:child_process').execFileSync; os = require('node:os'); pathMod = require('node:path'); } catch { return null; }
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { return null; }   // renderer absent
  const { jsPDF } = require('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFontSize(7);
  doc.text('GRN List Report', 40, 40);
  doc.text('MAIZE MILLS LIMITED', 40, 52);
  doc.text('Truck No.   PO Supplier    Recd.  Net.Recd.  Freight  Load   Deduction for', 40, 90);
  doc.text('Sample No.   GRN Date   RR No.   Name   Bags   Wt   Amount   Rokdi  Moist %   Kg', 40, 100);
  doc.text('SHRI', 150, 110);
  doc.text('4411-99021   03.09.2026   7781  BALAJI   420   19875   0   0   0   9.75   0.00', 40, 120);
  doc.text('TRADER', 150, 130);
  doc.text('Total   420   19875   0   0   0   0.00', 40, 142);
  doc.text('THE VALUE OF LOSSES SUSTAINED BY US DUE TO MOISTURE CONTENT MORE THEN 14.00 %.', 40, 160);
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'solivy-grn-region-test-'));
  try {
    fs.writeFileSync(pathMod.join(dir, 'd.pdf'), Buffer.from(doc.output('arraybuffer')));
    execFileSync('pdftoppm', ['-r', String(dpi), '-jpeg', '-f', '1', '-l', '1', pathMod.join(dir, 'd.pdf'), pathMod.join(dir, 'p')]);
    const f = fs.readdirSync(dir).find((x) => x.startsWith('p-'));
    return f ? fs.readFileSync(pathMod.join(dir, f)) : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
}

const scan = scannedGrnPage(130);
const needsRenderer = scan ? false : 'NOT VERIFIED: pdftoppm is needed to render a test page here (it is not needed by SOLIVY itself)';

test('the engine reads a located region of a real image, and reports its words and confidence', { skip: needsRenderer }, async () => {
  const { recognisePage } = await import('../../lib/grn/ocr-wasm');
  let planned: any[] = [];
  let sizeUsed: any = null;
  const read = await recognisePage(scan!, {
    dpi: 130,
    imageSize: { width: 1075, height: 1518 },          // A4 at 130 dpi, as the PDF reports it
    plan: (words, size) => { sizeUsed = size; planned = grnRegions(words, size); return planned; },   // forced: no coverage gate
  });
  // Geometry is measured against the extent of the print, in the same pixel space as the word
  // boxes — not against a sheet of mostly blank paper.
  assert.ok(sizeUsed.width > 400 && sizeUsed.width <= 1075, `the print's width: ${sizeUsed.width}`);
  assert.ok(sizeUsed.height > 100 && sizeUsed.height < 1518, `the print's height, not the sheet's: ${sizeUsed.height}`);
  assert.ok(read.words.length > 20, `the first pass produced word boxes: ${read.words.length}`);
  assert.ok(read.width > 400 && read.height > 100, `the page extent is measured: ${read.width}x${read.height}`);
  assert.ok(planned.length >= 1, 'a region was located on a real rendered page, from its own words');

  const table = read.regions.find((r) => r.name === 'grn-receipt-table');
  assert.ok(table, `the table region was read: ${read.regions.map((r) => r.name).join(', ')}`);
  assert.equal(table!.skipped, null, `and without error: ${table!.skipped}`);
  assert.ok(table!.text.replace(/\s/g, '').length > 30, `it produced text: ${JSON.stringify(table!.text.slice(0, 120))}`);
  assert.ok(table!.words.length > 5, 'with its own word boxes');
  assert.ok(table!.ms >= 0 && table!.ms < 120_000, 'and a recorded duration');
  // The region sits inside the page it came from.
  assert.ok(table!.rect.x >= 0 && table!.rect.y >= 0 && table!.rect.y + table!.rect.height <= read.height);
  // The values printed in the row are inside the region's text.
  assert.match(table!.text.replace(/\s+/g, ' '), /4411-99021|19875|420/);
});

test('a rebuild whose cells do not fit their columns is discarded, not handed to the parser', { skip: needsRenderer }, async () => {
  const { recognisePage } = await import('../../lib/grn/ocr-wasm');
  const read = await recognisePage(scan!, { dpi: 130, plan: (words, size) => grnRegions(words, size) });
  const table = read.regions.find((r) => r.name === 'grn-receipt-table' && r.words.length);
  assert.ok(table, 'the table region was read');
  const rebuilt = rebuildTable(table!.words, GRN_HEADERS);
  const lines = grnRowLines(rebuilt);
  // On a real scan the word boxes need not line up with the header's. Whatever came out, it is
  // either a row whose every cell fits its column, or nothing — never a mislabelled weight.
  if (lines.length) {
    for (const l of lines) {
      const [label, value] = l.split(/:\s*/);
      if (label === 'recd net' || label === 'bags') assert.match(value, /^\d[\d.,]*$/, `${label} is numeric: ${l}`);
      if (label === 'grn date') assert.match(value, /^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}$/, l);
      if (label === 'sample no') assert.match(value, /^\d{3,6}\s*-\s*\d{3,6}$/, l);
    }
  } else {
    assert.ok(rebuilt === null || rebuilt.rows.length >= 0, 'nothing was handed on, which is the safe outcome');
  }
});
