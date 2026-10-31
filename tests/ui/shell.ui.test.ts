/**
 * v2.8.0 interface tests: the restructured navigation, the themes, the profile module and the
 * mobile layout, running the real app in Chromium against the real API.
 * Tailwind is not compiled here, so these verify structure, behaviour and layout metrics — not the
 * compiled visual styling.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
let chromium: any = null;
try { chromium = require('playwright').chromium; } catch { try { chromium = require('/opt/npm-tools/node_modules/playwright').chromium; } catch {} }
const SKIP = chromium ? false : 'NOT VERIFIED: Playwright/Chromium not available';

let server: ChildProcess | null = null; let base = ''; let browser: any; let ctx: any; let page: any; let companyId = 0;
const errors: string[] = [];

before(async () => {
  if (SKIP) return;
  const app = await import('../helpers/app');
  const { seedFinance } = await import('../helpers/seed-finance');
  const s = await app.adminSession();
  companyId = s.companyId;
  await seedFinance(s.cookie);
  await app.seedUser({ username: 'uiadmin', role: 'ADMIN', companies: [{ id: s.companyId, live: true, test: true }] });
  (await import('../../lib/db')).closeAllDatabases();

  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-shell-'));
  let esbuild: any; try { esbuild = require('esbuild'); } catch { esbuild = require('/opt/npm-tools/node_modules/esbuild'); }
  await esbuild.build({ entryPoints: [path.join(ROOT, 'tests/ui/shell-entry.tsx')], bundle: true, outfile: path.join(uiDir, 'bundle.js'), format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(ROOT, 'node_modules'), '/opt/npm-tools/node_modules'], loader: { '.css': 'empty' }, logLevel: 'silent' });
  // The real stylesheets are linked so layout and theme tokens are exercised (Tailwind utility
  // classes are not compiled in this harness, so only the hand-written CSS applies).
  fs.writeFileSync(path.join(uiDir, 'globals.css'), fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8').replace(/@import\s+'tailwindcss';?/, ''));
  fs.copyFileSync(path.join(ROOT, 'app/theme.css'), path.join(uiDir, 'theme.css'));
  fs.copyFileSync(path.join(ROOT, 'app/dashboard.css'), path.join(uiDir, 'dashboard.css'));
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SOLIVY</title><link rel="stylesheet" href="/__ui/globals.css"><link rel="stylesheet" href="/__ui/dashboard.css"><link rel="stylesheet" href="/__ui/theme.css"></head><body><div id="root"></div><script src="/__ui/bundle.js"></script></body></html>');

  server = spawn(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', path.join(ROOT, 'tests/helpers/server.ts'), '0'], { env: { ...process.env, SOLIVY_UI_DIR: uiDir, SOLIVY_UI_ROOT: '1' }, cwd: ROOT });
  base = await new Promise((resolve, reject) => { server!.stdout!.on('data', (d) => { const m = String(d).match(/LISTENING (\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); }); server!.on('exit', (c) => reject(new Error(`server exit ${c}`))); });
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  page = await ctx.newPage();
  page.on('response', async (r: any) => { if (r.status() >= 400 && !/\.(png|ico|svg|jpg)$/.test(new URL(r.url()).pathname)) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on('console', (m: any) => { if (m.type() === 'error' && !/Failed to load resource|favicon|solivy-logo/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e: any) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/login`);
  // Other test files may have seeded further organizations in this process; sign in to this one.
  await page.locator('select').first().selectOption(String(companyId));
  await page.getByLabel(/Username/i).fill('uiadmin');
  await page.getByLabel(/Password/i).fill('Correct-Horse-9');
  await Promise.all([page.waitForURL((u: any) => new URL(String(u)).pathname === '/', { timeout: 30000 }), page.getByRole('button', { name: /Sign in/i }).click()]);
  await page.locator('button:has-text("ID: parties")').first().waitFor({ timeout: 30000 });
});
after(async () => { await browser?.close(); server?.kill(); });

const shot = async (name: string, target: any = page) => { fs.mkdirSync(path.join(ROOT, 'docs/ui'), { recursive: true }); await target.screenshot({ path: path.join(ROOT, `docs/ui/${name}.png`), fullPage: false }); };

test('the sidebar shows the four task groups and administration, and the removed entries are gone', { skip: SKIP }, async () => {
  for (const group of ['Core Finance', 'Collection & Funding', 'Purchases', 'Reconciliation & Reports', 'Administration & Sync']) {
    assert.ok(await page.locator('aside').getByText(group, { exact: true }).count(), `group ${group} present`);
  }
  for (const key of ['ledger', 'tally-export', 'gst', 'secondary-backup']) {
    assert.equal(await page.locator(`aside button:has-text("ID: ${key}")`).count(), 0, `${key} is not listed`);
  }
  // Representative entries are still reachable in their new groups.
  for (const key of ['dashboard', 'accounts', 'parties', 'party-aliases', 'money-in', 'money-out', 'transfers', 'funding', 'purchase', 'sauda', 'payments', 'bank', 'commercial-bills', 'reports', 'profile', 'sync']) {
    assert.ok(await page.locator(`aside button:has-text("ID: ${key}")`).count(), `${key} is listed`);
  }
  await shot('v280-dashboard-light');
});

test('the removed screens still work when opened directly (no functionality was deleted)', { skip: SKIP }, async () => {
  const api = async (p: string) => page.evaluate(async (u: string) => { const r = await fetch(u, { headers: { 'x-aksh-mode': 'LIVE' } }); return r.status; }, p);
  assert.ok([200, 304].includes(await api('/api/data?modules=core,ledger')), 'vendor ledger data still served');
  assert.ok([200, 304].includes(await api('/api/tally-export?types=purchases')), 'tally export still served');
  assert.ok([200, 304].includes(await api('/api/export/gst?from=2026-04-01&to=2027-03-31')), 'GST export still served');
  assert.ok([200, 304].includes(await api('/api/secondary-backup')), 'secondary backup still served');
});

test('light, dark and accent themes apply and persist across a reload', { skip: SKIP }, async () => {
  const mode = () => page.evaluate(() => document.documentElement.dataset.mode);
  const accent = () => page.evaluate(() => document.documentElement.dataset.accent);
  assert.equal(await mode(), 'light');
  await page.locator('.theme-switch button[aria-label="Dark"]').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark', { timeout: 5000 });
  const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());
  assert.equal(canvas, '#0b1120', 'dark tokens are in force');
  await page.locator('.accent-dot[aria-label="blue theme"]').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'blue', { timeout: 5000 });
  await shot('v280-dashboard-dark');
  await page.reload();
  await page.locator('button:has-text("ID: parties")').first().waitFor({ timeout: 30000 });
  assert.equal(await mode(), 'dark', 'the mode survived the reload');
  assert.equal(await accent(), 'blue', 'the accent survived the reload');
  await page.locator('.theme-switch button[aria-label="Light"]').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'light', { timeout: 5000 });
});

test('the profile module shows identity, organisation, permissions, session and a password form', { skip: SKIP }, async () => {
  await page.locator('aside button:has-text("ID: profile")').first().click();
  await page.getByRole('heading', { name: 'Organisation' }).waitFor({ timeout: 15000 });
  for (const heading of ['Organisation', 'Session & security', 'Modules you can use', 'Appearance', 'Change password']) {
    assert.ok(await page.getByRole('heading', { name: heading }).count(), heading);
  }
  assert.ok(await page.getByText('@uiadmin').count(), 'the signed-in user is named');
  assert.ok(await page.getByText(/ID \d+/).count(), 'the user ID is shown');
  assert.ok(await page.getByText('All modules (administrator)').count(), 'permissions are described');
  await page.getByLabel('Current password').fill('wrong-password-123');
  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByLabel('Confirm new password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByRole('alert').waitFor({ timeout: 10000 });
  assert.match(await page.getByRole('alert').innerText(), /at least 12 characters/i, 'the weak password is refused in the browser');
  await shot('v280-profile');
});

test('mobile: a drawer, touch-sized controls and no horizontal overflow', { skip: SKIP }, async () => {
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${base}/`);
  await phone.locator('.mobile-menu-toggle').waitFor({ timeout: 30000 });
  const overflow = async () => phone.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  let o = await overflow();
  assert.ok(o.scroll <= o.client + 1, `no horizontal overflow on the dashboard (${o.scroll} vs ${o.client})`);
  await phone.locator('.mobile-menu-toggle').click();
  await phone.locator('.mobile-drawer').waitFor({ timeout: 10000 });
  for (const group of ['Core Finance', 'Collection & Funding', 'Purchases', 'Reconciliation & Reports']) {
    assert.ok(await phone.locator('.mobile-drawer').getByText(group, { exact: true }).count(), `drawer group ${group}`);
  }
  const box = await phone.locator('.mobile-drawer-item').first().boundingBox();
  assert.ok(box && box.height >= 44, `drawer items are touch sized (${box?.height}px)`);
  await shot('v280-mobile-drawer', phone);
  await phone.locator('.mobile-drawer-item:has-text("Purchase")').first().click();
  await phone.waitForTimeout(800);
  o = await overflow();
  assert.ok(o.scroll <= o.client + 1, `no horizontal overflow on the purchase screen (${o.scroll} vs ${o.client})`);
  const toggleBox = await phone.locator('.mobile-menu-toggle').boundingBox();
  assert.ok(toggleBox && toggleBox.height >= 36, 'the menu button is touch sized');
  await shot('v280-mobile-purchase', phone);
  await phone.close();
});

test('no browser errors were raised during the interface tests', { skip: SKIP }, async () => {
  assert.deepEqual(errors, []);
});
