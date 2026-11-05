/**
 * Browser test (Chromium, Playwright): the GRN import wizard the Add Purchase modal opens.
 * Verifies the reported crash cannot recur, that the whole document is reported, that only
 * accepted fields are handed back, and that nothing is ever posted from the wizard.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(__dirname, '..', '..');
let browser: any; let page: any; let server: http.Server | null = null; let base = '';
const errors: string[] = [];
let chromium: any = null;
try { chromium = require('playwright').chromium; } catch { try { chromium = require('/opt/npm-tools/node_modules/playwright').chromium; } catch { /* absent */ } }
const SKIP = chromium ? false : 'NOT VERIFIED: Playwright/Chromium not available';

before(async () => {
  if (SKIP) return;
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-grn-ui-'));
  let esbuild: any; try { esbuild = require('esbuild'); } catch { esbuild = require('/opt/npm-tools/node_modules/esbuild'); }
  await esbuild.build({ entryPoints: [path.join(ROOT, 'tests/ui/grn-entry.tsx')], bundle: true, outfile: path.join(uiDir, 'bundle.js'), format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(ROOT, 'node_modules'), '/opt/npm-tools/node_modules'], logLevel: 'silent' });
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>GRN</title></head><body><div id="root"></div><script src="./bundle.js"></script></body></html>');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd4', 'hex');
  server = http.createServer((req, res) => {
    // The page preview is an <img>, which the harness's fetch stub cannot intercept.
    if ((req.url || '').startsWith('/api/grn')) { res.setHeader('content-type', 'image/png'); res.end(PNG); return; }
    const file = path.join(uiDir, (req.url || '/').split('?')[0].replace(/^\//, '') || 'index.html');
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server!.address() as any).port}`;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e: any) => errors.push(String(e)));
});
after(async () => { await browser?.close(); server?.close(); });

let visit = 0;
async function uploadInto(hash: string) {
  // A bare hash change is a same-document navigation: the component would keep its state and the
  // file input (only on the first step) would not be there. The query makes it a real load.
  await page.goto(`${base}/index.html?v=${++visit}${hash}`);
  await page.getByRole('dialog', { name: 'Import from GRN or PDF' }).waitFor({ timeout: 15000 });
  await page.locator('[data-testid="grn-file"]').setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await page.locator('[data-testid="grn-summary"], [data-testid="grn-error"]').first().waitFor({ timeout: 15000 });
}

test('a response with no draft shows the failure instead of crashing', { skip: SKIP }, async () => {
  await uploadInto('#nodraft');
  const error = await page.locator('[data-testid="grn-error"]').textContent();
  assert.match(String(error), /No text could be read/);
  assert.match(String(await page.locator('[data-testid="grn-summary"]').textContent()), /3 pages/);
  assert.equal(await page.locator('[data-testid="grn-apply"]').isDisabled(), true, 'nothing can be handed back');
  assert.deepEqual(errors.filter((e) => /calculation|undefined/.test(e)), [], `no crash: ${errors.join(' | ')}`);
});

test('a response that is not JSON at all is reported, not thrown', { skip: SKIP }, async () => {
  errors.length = 0;
  await uploadInto('#malformed');
  assert.ok(await page.locator('[data-testid="grn-error"]').isVisible());
  assert.deepEqual(errors.filter((e) => /Cannot read properties/.test(e)), [], errors.join(' | '));
});

test('a complete extraction lists the pages, the fields, the duplicates and the live total', { skip: SKIP }, async () => {
  errors.length = 0;
  await uploadInto('#ok');
  const summary = String(await page.locator('[data-testid="grn-summary"]').textContent());
  assert.match(summary, /2 pages/);
  assert.match(summary, /GRN on page 1/);
  assert.match(summary, /bill on page 2/);
  assert.ok(await page.locator('[data-testid="grn-page-image"]').isVisible(), 'the source page is shown');
  assert.match(String(await page.locator('[data-testid="grn-duplicates"]').textContent()), /2627-22603 already exists/);
  assert.match(String(await page.locator('[data-testid="grn-warnings"]').textContent()), /₹20 per kg/);
  assert.match(String(await page.locator('[data-testid="grn-calc"]').textContent()), /Net payable ₹4,25,240/);
  assert.deepEqual(errors, [], errors.join(' | '));
});

test('only the ticked fields are handed back, and a field already typed is not overwritten unless chosen', { skip: SKIP }, async () => {
  await uploadInto('#ok');
  // truck_number is already typed in the form, so it is not ticked by default.
  assert.equal(await page.locator('input[data-field="truck_number"]').isChecked(), false, 'a value already in the form is not proposed silently');
  assert.equal(await page.locator('input[data-field="net_weight"]').isChecked(), true);
  await page.locator('input[data-field="rate"]').uncheck();
  await page.locator('[data-testid="grn-apply"]').click();
  const applied = JSON.parse(String(await page.locator('#applied-state').textContent()));
  assert.ok(Object.prototype.hasOwnProperty.call(applied.values, 'net_weight'));
  assert.ok(!Object.prototype.hasOwnProperty.call(applied.values, 'rate'), 'an unticked field is not handed back');
  assert.ok(!Object.prototype.hasOwnProperty.call(applied.values, 'truck_number'), 'the typed vehicle number survives');
  const form = JSON.parse(String(await page.locator('#form-state').textContent()));
  assert.equal(form.truck_number, 'TYPED-BY-HAND', 'the manual value is intact');
  assert.equal(form.net_weight, 21262);
  assert.equal(applied.meta.documentId, 11);
});

test('editing a value updates the total, and the wizard never posts', { skip: SKIP }, async () => {
  await uploadInto('#ok');
  await page.locator('input[data-value="rate"]').fill('25');
  await page.locator('[data-testid="grn-calc"]').getByText('Net payable ₹5,31,550').waitFor({ timeout: 5000 });
  const posts: string[] = await page.evaluate(() => (window as any).__posts || []);
  assert.deepEqual(posts.filter((p) => /POST \/api\/purchases/.test(p)), [], 'the wizard posted no purchase');
  assert.deepEqual(posts.filter((p) => /POST \/api\/grn/.test(p)).length, 1, 'exactly one upload');
});

test('cancel and Escape close the wizard without handing anything back', { skip: SKIP }, async () => {
  await uploadInto('#ok');
  await page.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.locator('#applied-state').textContent(), 'none');
  await page.locator('#reopen').click();
  await page.getByRole('dialog', { name: 'Import from GRN or PDF' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Import from GRN or PDF' }).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await page.locator('#applied-state').textContent(), 'none');
  const form = JSON.parse(String(await page.locator('#form-state').textContent()));
  assert.equal(form.truck_number, 'TYPED-BY-HAND', 'the manual form is untouched by opening and closing the wizard');
});

// ---- v2.10.2: the machine with no recognition engine -------------------------------------------

test('a scan that could not be read offers every field to type in, against the page image', { skip: SKIP }, async () => {
  errors.length = 0;
  await uploadInto('#manual');
  assert.ok(await page.locator('[data-testid="grn-manual"]').isVisible(), 'the position is explained');
  assert.match(String(await page.locator('[data-testid="grn-manual"]').textContent()), /type it in/i);
  const summary = String(await page.locator('[data-testid="grn-summary"]').textContent());
  assert.match(summary, /2 pages/, 'the real page count');
  assert.match(summary, /read by eye/, 'and how it is to be read');
  assert.ok(await page.locator('[data-testid="grn-page-image"]').isVisible(), 'the page is shown to read from');

  // Every field is offered, not only the ones that carried a value.
  const rows = await page.locator('[data-testid="grn-fields"] tr').count();
  assert.ok(rows >= 19, `every field is listed to type into, got ${rows}`);
  assert.equal(await page.locator('input[data-field="net_weight"]').isChecked(), false, 'nothing is ticked, because nothing was read');
  assert.equal(await page.locator('[data-testid="grn-apply"]').isDisabled(), true, 'and nothing can be handed back yet');

  // Typing a value ticks it and moves the total, by the purchase form's own rules.
  await page.locator('input[data-value="net_weight"]').fill('21262');
  await page.locator('input[data-value="rate"]').fill('20');
  assert.equal(await page.locator('input[data-field="net_weight"]').isChecked(), true, 'a typed value is used');
  await page.locator('[data-testid="grn-calc"]').getByText('Net payable ₹4,25,240').waitFor({ timeout: 5000 });

  await page.locator('[data-testid="grn-apply"]').click();
  const applied = JSON.parse(String(await page.locator('#applied-state').textContent()));
  assert.equal(applied.values.net_weight, 21262);
  assert.equal(applied.values.rate, 20);
  assert.ok(!Object.prototype.hasOwnProperty.call(applied.values, 'freight'), 'a field left empty is not handed back as zero');
  assert.equal(applied.meta.documentId, 12);
  const posts: string[] = await page.evaluate(() => (window as any).__posts || []);
  assert.deepEqual(posts.filter((p) => /POST \/api\/purchases/.test(p)), [], 'still nothing posted');
  assert.deepEqual(errors, [], errors.join(' | '));
});

// ---- v2.11.0: the engine that ships with SOLIVY ------------------------------------------------

test('the review screen shows which engine read the document, page by page', { skip: SKIP }, async () => {
  errors.length = 0;
  await uploadInto('#ok');
  await page.locator('[data-testid="grn-diagnostics-toggle"]').click();
  const panel = String(await page.locator('[data-testid="grn-diagnostics"]').textContent());
  assert.match(panel, /OCR engine built into SOLIVY/, 'the engine is named');
  assert.match(panel, /5\.1\.0-288/, 'with its version');
  assert.match(panel, /language data eng/, 'and its language data');
  assert.match(panel, /nothing was sent off this machine/);
  assert.match(panel, /recognised/, 'each page carries its status');
  assert.match(panel, /85%/, 'and its recognition confidence');
  assert.match(panel, /4\.1s/, 'and how long it took');
  assert.deepEqual(errors, [], errors.join(' | '));
});

test('each recognised field shows its confidence, and a value you type is marked as yours', { skip: SKIP }, async () => {
  await uploadInto('#ok');
  assert.equal(await page.locator('[data-confidence="sample_no"]').textContent(), 'high');
  assert.equal(await page.locator('[data-confidence="net_weight"]').textContent(), 'medium');
  assert.equal(await page.locator('[data-edited="net_weight"]').count(), 0, 'nothing is marked edited to begin with');
  await page.locator('input[data-value="net_weight"]').fill('21000');
  await page.locator('[data-edited="net_weight"]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('[data-edited="net_weight"]').textContent(), 'you edited', 'an entered value is distinguished from a recognised one');
});

test('when no engine can be used the reason and the fix are on screen', { skip: SKIP }, async () => {
  await uploadInto('#manual');
  assert.ok(await page.locator('[data-testid="grn-manual"]').isVisible());
  await page.locator('[data-testid="grn-diagnostics-toggle"]').click();
  const panel = String(await page.locator('[data-testid="grn-diagnostics"]').textContent());
  assert.match(panel, /bundled OCR engine is missing/, 'the reason is stated');
  assert.match(panel, /SOLIVY_GRN_OCR_WASM_DIR|Reinstall SOLIVY/, 'and the fix');
  assert.match(panel, /not-attempted/, 'and no page is claimed to have been read');
});

// ---- v2.12.0: a consignment list of many GRNs --------------------------------------------------

test('every consignment row of a list is shown with its columns, and one is reviewed at a time', { skip: SKIP }, async () => {
  errors.length = 0;
  await uploadInto('#multi');
  const rowsPanel = page.locator('[data-testid="grn-rows"]');
  assert.ok(await rowsPanel.isVisible(), 'the list of consignments is shown');
  assert.match(String(await rowsPanel.textContent()), /3 consignments on this list/);
  assert.match(String(await rowsPanel.textContent()), /3 row\(s\) printed · 3 read · 0 unresolved · 2 supplier bill\(s\) · 2 goods line\(s\)/);

  // One table row per GRN, each with its own figures — not the first row repeated.
  const bodyRows = page.locator('[data-testid="grn-rows"] tbody tr');
  assert.equal(await bodyRows.count(), 3, 'three rows, not one');
  const text = String(await rowsPanel.textContent());
  for (const sample of ['2627-23766', '2627-23720', '2627-24234']) assert.ok(text.includes(sample), `${sample} is listed`);
  for (const net of ['30,135', '36,240', '24,472']) assert.ok(text.includes(net), `${net} is listed`);
  assert.ok(text.includes('page 2'), 'the matched bill page is shown');
  assert.ok(text.includes('none matched'), 'and so is a row with no bill');

  // The printed total disagreeing with the rows is reported.
  assert.match(String(await page.locator('[data-testid="grn-totals-check"]').textContent()), /rows add to 1,890 against 1,900 printed/);

  // The first row is under review, and its own draft is in the fields.
  assert.equal(await page.locator('input[data-value="net_weight"]').inputValue(), '30135');
  // Choosing the third row replaces the fields with that row's draft — nothing is combined.
  await page.locator('[data-testid="grn-row-p1r3"]').click();
  await page.waitForFunction(() => (document.querySelector('input[data-value="net_weight"]') as HTMLInputElement)?.value === '24472', null, { timeout: 5000 });
  assert.equal(await page.locator('input[data-value="sample_no"]').inputValue(), '2627-24234');
  // The reviewed row's own figures, through purchaseCalc: 24,472 kg at ₹27.50 is ₹6,72,980 gross,
  // less the ₹495 load/unload and ₹455 rokdi this consignment carries.
  const calcText = String(await page.locator('[data-testid="grn-calc"]').textContent());
  assert.match(calcText, /Gross ₹6,72,980/);
  assert.match(calcText, /Deductions ₹950/);
  assert.match(calcText, /Net payable ₹6,72,030/);

  // Handing it back names the consignment, and carries only that row's values.
  await page.locator('[data-testid="grn-apply"]').click();
  const applied = JSON.parse(String(await page.locator('#applied-state').textContent()));
  assert.equal(applied.values.net_weight, 24472, 'the reviewed row, not the first');
  assert.equal(applied.values.sample_no, '2627-24234');
  const posts: string[] = await page.evaluate(() => (window as any).__posts || []);
  assert.deepEqual(posts.filter((p) => /POST \/api\/purchases/.test(p)), [], 'nothing was posted');
  assert.deepEqual(errors, [], errors.join(' | '));
});

test('every page of the upload is listed, with the rate of each bill or the fact it was not read', { skip: SKIP }, async () => {
  await uploadInto('#multi');
  const pages = page.locator('[data-testid="grn-pages"]');
  assert.ok(await pages.isVisible());
  await pages.locator('summary').click();
  const text = String(await pages.textContent());
  assert.match(text, /All 5 pages/);
  for (const title of ['Goods receipt list', 'Tax invoice', 'Bill of supply', 'Handwritten or stamped slip', 'Not recognised']) {
    assert.ok(text.includes(title), `${title} is listed`);
  }
  assert.ok(text.includes('₹2750 per QTL'), 'a printed rate is shown as printed');
  assert.match(text, /not read \(amount ÷ quantity = 2900, a check only\)/, 'and an unread rate is never shown as the rate');
});
