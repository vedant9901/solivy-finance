/**
 * Browser test: the real ReportsHub component (bundled with esbuild) in Chromium (Playwright),
 * talking to the real API through tests/helpers/server.ts. Tailwind is not compiled here, so
 * this verifies behaviour and content, not visual styling.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
let server: ChildProcess | null = null; let base = ''; let cookie = ''; let browser: any; let page: any; const errors: string[] = [];
let chromium: any = null;
try { chromium = require('playwright').chromium; } catch { try { chromium = require('/opt/npm-tools/node_modules/playwright').chromium; } catch {} }
const SKIP = chromium ? false : 'NOT VERIFIED: Playwright/Chromium not available';

before(async () => {
  if (SKIP) return;
  const app = await import('../helpers/app');
  const { seedFinance } = await import('../helpers/seed-finance');
  const s = await app.adminSession();
  await seedFinance(s.cookie);
  (await import('../../lib/db')).closeAllDatabases();
  cookie = s.cookie;
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-ui-'));
  let esbuild: any; try { esbuild = require('esbuild'); } catch { esbuild = require('/opt/npm-tools/node_modules/esbuild'); }
  await esbuild.build({ entryPoints: [path.join(ROOT, 'tests/ui/entry.tsx')], bundle: true, outfile: path.join(uiDir, 'bundle.js'), format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(ROOT, 'node_modules'), '/opt/npm-tools/node_modules'], logLevel: 'silent' });
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Reports</title></head><body><div id="root"></div><script src="/__ui/bundle.js"></script></body></html>');
  server = spawn(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', path.join(ROOT, 'tests/helpers/server.ts'), '0'], { env: { ...process.env, SOLIVY_UI_DIR: uiDir }, cwd: ROOT });
  base = await new Promise((resolve, reject) => { server!.stdout!.on('data', (d) => { const m = String(d).match(/LISTENING (\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); }); server!.on('exit', (c) => reject(new Error(`server exit ${c}`))); });
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: 'aksh_session', value: cookie, domain: '127.0.0.1', path: '/' }]);
  page = await ctx.newPage();
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e: any) => errors.push(String(e)));
});
after(async () => { await browser?.close(); server?.kill(); });

test('hub renders grouped cards, search and starring work', { skip: SKIP }, async () => {
  await page.goto(`${base}/__ui/index.html`);
  await page.getByText('Balance Sheet', { exact: true }).waitFor({ timeout: 15000 });
  for (const g of ['Company & Financial', 'Customers & Receivables', 'Vendors & Payables', 'Accountant & Taxes', 'Combined / Multi-company']) assert.ok(await page.getByRole('heading', { name: g }).count(), g);
  await page.getByPlaceholder('Search reports…').fill('aging');
  assert.equal(await page.locator('.card button.flex-1').count(), 2);
  await page.getByPlaceholder('Search reports…').fill('');
  await page.getByLabel('Star Trial Balance').click();
  await page.getByRole('button', { name: /Starred \(1\)/ }).click();
  assert.equal(await page.locator('.card button.flex-1').count(), 1);
  await page.getByRole('button', { name: /Starred/ }).click();
  fs.mkdirSync(path.join(ROOT, 'docs/ui'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'docs/ui/reports-hub-unstyled.png'), fullPage: true });
});

test('balance sheet runs with Indian number formatting; drill-down opens the general ledger', { skip: SKIP }, async () => {
  await page.getByText('Balance Sheet', { exact: true }).click();
  await page.locator('input[type=date]').first().fill('2027-03-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  await page.getByText('Total assets').first().waitFor({ timeout: 15000 });
  assert.ok(await page.getByText('19,39,500.00').count(), 'total assets in Indian grouping');
  await page.getByRole('button', { name: 'Trade Payables' }).click();
  await page.locator('h2', { hasText: 'General Ledger' }).waitFor({ timeout: 15000 });
  await page.locator('h3', { hasText: '2100 Trade Payables' }).first().waitFor({ timeout: 15000 });
  const csv = await page.getByRole('link', { name: 'CSV' }).getAttribute('href');
  assert.match(csv, /id=general-ledger.*account=2100.*format=csv/);
  await page.screenshot({ path: path.join(ROOT, 'docs/ui/general-ledger-drilldown-unstyled.png'), fullPage: true });
});

test('budget editor saves and Budget Overview reflects it; legacy MIS view still reachable', { skip: SKIP }, async () => {
  await page.getByRole('button', { name: /All reports/ }).click();
  await page.getByText('Budget Overview', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit budget' }).click();
  await page.getByLabel('Interest Expense 2026-05').fill('8000');
  await page.getByRole('button', { name: 'Save budget' }).click();
  await page.getByText('Budget saved.').waitFor({ timeout: 15000 });
  await page.getByText('8,000.00').first().waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /All reports/ }).click();
  await page.getByRole('button', { name: /MIS & Registers/ }).click();
  await page.locator('#legacy-mis').waitFor();
  assert.deepEqual(errors, [], 'no browser console errors');
});

test('bill templates panel: choose template, live preview loads in-frame, save persists', { skip: SKIP }, async () => {
  const p2 = await page.context().newPage();
  const frameResponses: number[] = [];
  p2.on('response', (r: any) => { if (r.url().includes('/api/purchase-bill')) frameResponses.push(r.status()); });
  await p2.goto(`${base}/__ui/index.html#templates`);
  await p2.getByText('Bill templates').waitFor({ timeout: 15000 });
  await p2.getByText('Boxed GST grid').click();
  await p2.getByLabel('Accent #1d4ed8').click();
  const src = await p2.locator('iframe[title="Bill preview"]').getAttribute('src');
  assert.match(src, /template=boxed/); assert.match(src, /accent=%231d4ed8/); assert.match(src, /preview=1/);
  await p2.waitForTimeout(1500);
  assert.ok(frameResponses.includes(200), `preview fetched in frame: ${frameResponses}`);
  await p2.getByRole('button', { name: 'Save template' }).click();
  await p2.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 15000 });
  assert.match(await p2.getByText(/Current: boxed/).innerText(), /boxed \(user:/);
  await p2.screenshot({ path: path.join(ROOT, 'docs/ui/bill-templates-panel-unstyled.png'), fullPage: true });
  await p2.close();
});
