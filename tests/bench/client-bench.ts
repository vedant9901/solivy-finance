/**
 * Client workflow transfer benchmark: the REAL UI (app/page.tsx bundled with esbuild) in Chromium,
 * driving the REAL API through tests/helpers/server.ts, with the server in online mode against
 * PostgreSQL. Per workflow step it records
 *   - API requests (count, duplicates — same method+URL twice within the step),
 *   - response bytes seen by the browser,
 *   - PostgreSQL socket bytes read/written by the server (what Neon bills as transfer).
 *
 *   node --require ./tests/setup/register.cjs --import tsx tests/bench/client-bench.ts <out.json>
 * Env: BENCH_PG_URL (default local test cluster), BENCH_PURCHASES (default 300).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const PG = process.env.BENCH_PG_URL || 'postgres://postgres@127.0.0.1:54329';
const PURCHASES = Number(process.env.BENCH_PURCHASES || 300);
const phase = process.argv[2];

function req(mod: string) { try { return require(mod); } catch { return require('/opt/npm-tools/node_modules/' + mod); } }

/** Phase 1 (local SQLite): seed one organization with a realistic transaction volume. */
async function seed(dir: string) {
  const { call, seedOrg, seedUser, login, expectOk } = await import('../helpers/app');
  const id = await seedOrg({ companyName: 'Bench Traders', code: 'BENCHC' });
  const id2 = await seedOrg({ companyName: 'Bench Traders Two', code: 'BENCHD' });
  await seedUser({ username: 'benchadmin', role: 'ADMIN', companies: [{ id, live: true, test: true }, { id: id2, live: true, test: true }] });
  const cookie = await login('benchadmin', id, 'LIVE');
  expectOk(await call('/api/accounts', { cookie, body: { account_name: 'Main Bank', bank_name: 'HDFC', account_type: 'BANK', opening_balance: 50_000_000, opening_date: '2026-04-01' } }));
  for (let p = 0; p < 40; p++) expectOk(await call('/api/parties', { cookie, body: { name: `Vendor ${p}`, party_type: p % 4 === 0 ? 'CUSTOMER' : 'GOODS_VENDOR', address: 'Plot 12, APMC Yard, Unjha, Gujarat', contact: '98250' + String(10000 + p), gst: '24ABCDE' + String(1000 + p) + 'F1Z5' } }));
  const data = expectOk(await call('/api/data', { cookie }));
  const acct = data.accounts[0].id; const parties = data.parties.map((x: any) => x.id);
  for (let k = 0; k < PURCHASES; k++) {
    const day = String(1 + (k % 28)).padStart(2, '0'); const month = String(4 + (k % 6)).padStart(2, '0');
    expectOk(await call('/api/purchases', { cookie, body: { party_id: parties[k % parties.length], purchase_date: `2026-${month}-${day}`, net_weight: 9000 + k, gross_weight: 9100 + k, rate: 52 + (k % 7), freight: 1500, unload_charge: 400, discount_pct: 1, goods_description: 'Cumin seed (jeera) — machine clean', truck_number: `GJ02AB${1000 + k}`, invoice_no: `INV-${k}` } }));
    if (k % 3 === 0) expectOk(await call('/api/payments', { cookie, body: { party_id: parties[k % parties.length], payment_date: `2026-${month}-${day}`, amount: 200000, mode: 'BANK', company_account_id: acct } }));
    if (k % 5 === 0) expectOk(await call('/api/money-in', { cookie, body: { receipt_date: `2026-${month}-${day}`, account_id: acct, amount: 150000, receipt_type: 'SALE_PROCEEDS', party_id: parties[k % parties.length], narration: 'Receipt' } }));
  }
  fs.writeFileSync(path.join(dir, 'ids.json'), JSON.stringify({ id, id2 }));
}

/** Phase 2: upload the seeded SQLite files into a fresh PostgreSQL database (legacy format; the bridge upgrades it). */
async function upload(dir: string, dbName: string) {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: `${PG}/postgres` }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.query(`CREATE DATABASE ${dbName}`); await admin.end();
  const c = new Client({ connectionString: `${PG}/${dbName}` }); await c.connect();
  await c.query('CREATE TABLE IF NOT EXISTS solivy_sqlite_snapshots (db_key TEXT PRIMARY KEY, db_file BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const { id, id2 } = JSON.parse(fs.readFileSync(path.join(dir, 'ids.json'), 'utf8'));
  const Database = require('better-sqlite3');
  const files: Array<[string, string]> = [['admin', path.join(dir, 'admin.db')]];
  for (const cid of [id, id2]) for (const m of ['LIVE', 'TEST']) files.push([`company:${cid}:${m}`, cid === 1 ? path.join(dir, m === 'LIVE' ? 'live.db' : 'test.db') : path.join(dir, 'companies', String(cid), m === 'LIVE' ? 'live.db' : 'test.db')]);
  const sizes: Record<string, number> = {}; let total = 0;
  for (const [key, file] of files) {
    if (!fs.existsSync(file)) continue;
    const d = new Database(file); d.pragma('wal_checkpoint(TRUNCATE)'); d.close();
    const bytes = fs.readFileSync(file); total += bytes.length; sizes[key] = bytes.length;
    await c.query('INSERT INTO solivy_sqlite_snapshots(db_key,db_file) VALUES($1,$2) ON CONFLICT(db_key) DO UPDATE SET db_file=EXCLUDED.db_file', [key, bytes]);
  }
  await c.end();
  return { total, sizes, id, id2 };
}

type Step = { step: string; requests: number; duplicates: number; duplicate_urls: string[]; response_bytes: number; pg_read: number; pg_written: number; ms: number; urls: Record<string, number> };

async function measure(out: string) {
  const { chromium } = req('playwright');
  const esbuild = req('esbuild');
  const { id, id2 } = JSON.parse(process.env.BENCH_CLIENT_IDS!);
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-cb-ui-'));
  await esbuild.build({ entryPoints: [path.join(ROOT, 'tests/bench/client-entry.tsx')], bundle: true, outfile: path.join(uiDir, 'bundle.js'), format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(ROOT, 'node_modules'), '/opt/npm-tools/node_modules'], loader: { '.css': 'empty' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>SOLIVY</title></head><body><div id="root"></div><script src="/__ui/bundle.js"></script></body></html>');

  const server: ChildProcess = spawn(process.execPath, ['--require', path.join(__dirname, 'pg-instrument.cjs'), '--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', path.join(ROOT, 'tests/helpers/server.ts'), '0'], { env: { ...process.env, SOLIVY_UI_DIR: uiDir, SOLIVY_UI_ROOT: '1' }, cwd: ROOT });
  server.stderr?.on('data', (d) => process.stderr.write(String(d).slice(0, 400)));
  const base: string = await new Promise((resolve, reject) => { server.stdout!.on('data', (d) => { const m = String(d).match(/LISTENING (\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); }); server.on('exit', (c) => reject(new Error(`server exit ${c}`))); });

  const browser = await chromium.launch();
  let ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let page = await ctx.newPage();
  const seen: Array<{ url: string; method: string; bytes: number }> = [];
  page.on('response', async (r: any) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && !u.pathname.startsWith('/api/')) failures.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
    if (!u.pathname.startsWith('/api/')) return;
    let bytes = 0; try { bytes = Number((await r.allHeaders())['content-length'] || 0) || (await r.body()).length; } catch {}
    seen.push({ url: u.pathname + u.search, method: r.request().method(), bytes });
    if (r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${u.pathname}${u.search} :: ${String(await r.text().catch(() => '')).slice(0, 200)}`);
  });
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (m: any) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e: any) => consoleErrors.push(String(e).slice(0, 200)));

  const diag = async (tag: string) => {
    try { await page.screenshot({ path: `/tmp/cb-${tag}.png`, fullPage: true }); } catch {}
    try { fs.writeFileSync(`/tmp/cb-${tag}.txt`, `URL: ${page.url()}\nCONSOLE: ${consoleErrors.join(' | ').slice(0, 2000)}\nTEXT: ${(await page.locator('body').innerText()).slice(0, 3000)}`); } catch {}
  };
  const pg = async () => (await (await fetch(`${base}/__pgstats`)).json()) as { read: number; written: number };
  const steps: Step[] = [];
  let prefix = '';
  async function step(name: string, fn: () => Promise<void>) {
    seen.length = 0;
    const b = await pg(); const t = Date.now();
    try { await fn(); } catch (e) { await diag('fail-' + name.replace(/[^a-z0-9]+/gi, '-')); throw e; }
    await page.waitForTimeout(700); // let late effects/responses land
    const a = await pg();
    const counts: Record<string, number> = {};
    for (const s of seen) { const k = `${s.method} ${s.url}`; counts[k] = (counts[k] || 0) + 1; }
    const dupUrls = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
    steps.push({ step: prefix + name, requests: seen.length, duplicates: seen.length - Object.keys(counts).length, duplicate_urls: dupUrls, response_bytes: seen.reduce((x, s) => x + s.bytes, 0), pg_read: a.read - b.read, pg_written: a.written - b.written, ms: Date.now() - t, urls: counts });
  }

  async function flow() {
  // ---- 1. Login page + sign in (the real login screen, real POST /api/login)
  await step('1 login page load', async () => { await page.goto(`${base}/login`); await page.getByLabel(/Username/i).waitFor({ timeout: 20000 }); });
  await step('2 sign in (POST /api/login)', async () => {
    await page.getByLabel(/Username/i).fill('benchadmin');
    await page.getByLabel(/Password/i).fill('Correct-Horse-9');
    await Promise.all([page.waitForURL((u: any) => new URL(String(u)).pathname === '/', { timeout: 30000 }), page.getByRole('button', { name: /Sign in/i }).click()]);
    await page.locator('button:has-text("ID: parties")').first().waitFor({ timeout: 30000 });
  });
  // ---- 2. Dashboard (full app mount)
  await step('3 dashboard reload (initial load)', async () => { await page.reload(); await page.locator('button:has-text("ID: parties")').first().waitFor({ timeout: 20000 }); await page.waitForTimeout(800); });

  const tabs: Array<[string, string]> = [['Parties', 'parties'], ['Purchase / Sample', 'purchase'], ['Payment', 'payments'], ['Receivable', 'receivables'], ['Money In', 'money-in'], ['Money Out', 'money-out'], ['Vendor Ledger', 'ledger'], ['Bank / Cash Account', 'accounts'], ['Funding / Loan', 'funding'], ['Withdrawal / Transfer', 'account-movements'], ['Reports', 'reports'], ['Document Setting', 'document-settings'], ['Godown / Inventory', 'godowns']];
  const openTab = async (key: string) => { await page.locator(`button:has-text("ID: ${key}")`).first().click(); await page.waitForTimeout(500); };
  for (const [, key] of tabs) await step(`4 open tab: ${key}`, () => openTab(key));
  // ---- 3. Repeat switching between already-visited tabs (cache behaviour)
  await step('5 repeat switch ×6 (parties↔purchase↔payments, already loaded)', async () => {
    for (let i = 0; i < 2; i++) { await openTab('parties'); await openTab('purchase'); await openTab('payments'); }
  });
  // ---- 4. Reports: open hub, run a report, change a filter
  await step('6 reports: open hub', () => openTab('reports'));
  await step('7 reports: run Balance Sheet', async () => {
    await page.getByText('Balance Sheet', { exact: true }).first().click();
    await page.locator('input[type=date]').first().fill('2027-03-31');
    await page.getByRole('button', { name: 'Run report' }).first().click();
    await page.waitForTimeout(1800);
  });
  await step('8 reports: change the as-of date and re-run', async () => {
    await page.locator('input[type=date]').first().fill('2026-12-31');
    await page.getByRole('button', { name: 'Run report' }).first().click();
    await page.waitForTimeout(1800);
  });
  await step('9 reports: open a second report (AR aging)', async () => {
    await page.getByRole('button', { name: /All reports/ }).first().click();
    await page.getByText('AR Aging', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Run report' }).first().click();
    await page.waitForTimeout(1800);
  });
  // ---- 5. Writes
  await step('10 create a party', async () => {
    await openTab('parties');
    await page.getByLabel('Party Name').first().fill('Bench Client Vendor ' + Date.now());
    await page.getByRole('button', { name: /SAVE PARTY/i }).first().click();
    await page.waitForTimeout(1200);
  });
  await step('11 second write (steady-state upload)', async () => {
    await page.getByLabel('Party Name').first().fill('Bench Client Vendor B ' + Date.now());
    await page.getByRole('button', { name: /SAVE PARTY/i }).first().click();
    await page.waitForTimeout(1200);
  });
  await step('12 switch away and back after the write', async () => { await openTab('payments'); await openTab('parties'); });
  await step('13 idle 30s (polling and background traffic)', async () => { await page.waitForTimeout(30000); });
  await step('14 switch environment LIVE → TEST', async () => {
    const sel = page.locator('select').filter({ hasText: 'LIVE' }).first();
    await sel.selectOption({ label: 'TEST' }).catch(async () => { await sel.selectOption('TEST'); });
    await page.waitForTimeout(1500);
  });
  await step('15 switch back TEST → LIVE', async () => {
    const sel = page.locator('select').filter({ hasText: 'LIVE' }).first();
    await sel.selectOption('LIVE').catch(() => {});
    await page.waitForTimeout(1500);
  });

  }

  // Pass A: first use of this database by this build (legacy conversion, schema upgrade, journal trim).
  prefix = 'A '; await flow();
  // Pass B: steady state — a new browser and a cold application instance against the same data.
  await fetch(`${base}/__fresh`);
  await ctx.close(); ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await ctx.newPage();
  page.on('response', async (r: any) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && !u.pathname.startsWith('/api/')) failures.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
    if (!u.pathname.startsWith('/api/')) return;
    let bytes = 0; try { bytes = Number((await r.allHeaders())['content-length'] || 0) || (await r.body()).length; } catch {}
    seen.push({ url: u.pathname + u.search, method: r.request().method(), bytes });
  });
  page.on('console', (m: any) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e: any) => consoleErrors.push(String(e).slice(0, 200)));
  prefix = 'B '; await flow();

  await browser.close(); server.kill();
  fs.writeFileSync(out, JSON.stringify({ steps, console_errors: consoleErrors, api_failures: failures, ids: { id, id2 } }, null, 2));
}

(async () => {
  if (phase === '--seed') return seed(process.env.FINANCE_DATA_DIR!);
  if (phase === '--measure') return measure(process.argv[3]);
  const out = path.resolve(phase || 'client-bench.json');
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-cb-seed-'));
  const env = { ...process.env, FINANCE_DATA_DIR: seedDir } as any; delete env.VERCEL;
  execFileSync(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', __filename, '--seed'], { env, stdio: 'inherit', cwd: ROOT });
  const dbName = process.env.BENCH_REUSE_DB || `clientbench_${Date.now()}`;
  const up = await upload(seedDir, dbName);
  if (!process.env.BENCH_REUSE_DB) console.log('seeded bench database:', dbName, '(set BENCH_REUSE_DB to reuse — it is re-seeded in place)');
  const tmp = out + '.steps.json';
  execFileSync(process.execPath, ['--require', path.join(ROOT, 'tests/setup/register.cjs'), '--import', 'tsx', __filename, '--measure', tmp], {
    env: { ...process.env, VERCEL: '1', DATABASE_URL: `${PG}/${dbName}`, SOLIVY_PG_SSL: 'disable', FINANCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-cb-run-')), BENCH_CLIENT_IDS: JSON.stringify({ id: up.id, id2: up.id2 }) } as any,
    stdio: 'inherit', cwd: ROOT,
  });
  const r = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), purchases: PURCHASES, snapshot_bytes_total: up.total, snapshot_sizes: up.sizes, ...r }, null, 2));
  fs.unlinkSync(tmp);
  console.table(r.steps.map((s: Step) => ({ step: s.step, reqs: s.requests, dup: s.duplicates, resp_KB: +(s.response_bytes / 1024).toFixed(1), pg_down_KB: +(s.pg_read / 1024).toFixed(1), pg_up_KB: +(s.pg_written / 1024).toFixed(1) })));
  for (const pass of ['A', 'B']) {
    const rows = r.steps.filter((s: Step) => s.step.startsWith(pass + ' '));
    if (!rows.length) continue;
    const tot = rows.reduce((a: any, s: Step) => ({ reqs: a.reqs + s.requests, dup: a.dup + s.duplicates, resp: a.resp + s.response_bytes, down: a.down + s.pg_read, up: a.up + s.pg_written }), { reqs: 0, dup: 0, resp: 0, down: 0, up: 0 });
    console.log(`PASS ${pass}: requests ${tot.reqs}, duplicates ${tot.dup}, response ${(tot.resp / 1024).toFixed(1)} KB, pg down ${(tot.down / 1024).toFixed(1)} KB, pg up ${(tot.up / 1024).toFixed(1)} KB`);
  }
  if (r.console_errors?.length) console.log('console errors:', r.console_errors.slice(0, 5));
  if (r.api_failures?.length) console.log('api failures:', r.api_failures.slice(0, 8));
})().catch((e) => { console.error(e); process.exit(1); });
