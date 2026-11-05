/**
 * v2.11.2 — loading the bundled OCR engine under any module system.
 *
 * Reported from a real installation: every page came back
 * `could not be recognised (undefined is not a function)`, and the wizard fell through to manual
 * entry. The engine files were present; the fault was that the engine module could not be *loaded*
 * by that build. `createRequire`, imported from `node:module`, can come back undefined once the
 * code has been through the Next.js server bundler — and `undefined(…)` is exactly that message.
 *
 * So the loader now tries five routes, each guarded by a `typeof` check, and records what it tried.
 * These tests drive **each route on its own** (`SOLIVY_GRN_OCR_LOAD_ROUTES`), so every fallback is
 * known to work rather than assumed to, and they assert that a total failure names the attempts
 * instead of surfacing a bare type error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as app from '../helpers/app';

const ROUTES = [
  ['createRequire', 'createRequire(node:module)'],
  ['import-module', 'await import(node:module).createRequire'],
  ['require', 'require'],
  ['eval-require', 'eval(require)'],
  ['import-url', 'await import(file url)'],
] as const;

/** A fresh copy of the module, so its one-per-process engine is loaded again under this setting. */
function freshModule() {
  const id = require.resolve('../../lib/grn/ocr-wasm');
  delete require.cache[id];
  return require('../../lib/grn/ocr-wasm');
}

async function withRoutes<T>(value: string | null, fn: (m: any) => Promise<T>): Promise<T> {
  const previous = process.env.SOLIVY_GRN_OCR_LOAD_ROUTES;
  if (value === null) delete process.env.SOLIVY_GRN_OCR_LOAD_ROUTES;
  else process.env.SOLIVY_GRN_OCR_LOAD_ROUTES = value;
  const m = freshModule();
  try { return await fn(m); }
  finally {
    try { m.disposeEngine(); } catch { /* nothing loaded */ }
    if (previous === undefined) delete process.env.SOLIVY_GRN_OCR_LOAD_ROUTES; else process.env.SOLIVY_GRN_OCR_LOAD_ROUTES = previous;
    freshModule();
  }
}

for (const [route, label] of ROUTES) {
  test(`the engine loads through "${route}" on its own, so this fallback really works`, async () => {
    await withRoutes(route, async (m) => {
      const r = await m.engineSelfTest();
      assert.equal(r.ok, true, `loaded: ${r.error}`);
      assert.equal(r.route, label, `by the expected route: ${r.route}`);
      assert.match(String(r.version), /^\d+\.\d+/, `and reports its version: ${r.version}`);
      assert.ok(r.ms >= 0 && r.ms < 120_000, 'in a recorded time');
    });
  });
}

test('with no route allowed, the failure names every attempt instead of a bare type error', async () => {
  await withRoutes('none-of-them', async (m) => {
    const r = await m.engineSelfTest();
    assert.equal(r.ok, false);
    assert.equal(r.route, null);
    const message = String(r.error);
    // The message a user can act on: which file, that it is present, and what was tried.
    assert.match(message, /could not be loaded by this build/i, message);
    assert.match(message, /tesseract-core-lstm\.wasm\.js/, 'it names the file');
    assert.match(message, /module-loading problem, not a missing engine/i, 'and distinguishes the two');
    assert.ok(!/undefined is not a function/i.test(message), `never the reported bare error: ${message}`);
    for (const [, label] of ROUTES) assert.ok(message.includes(label.split('(')[0]), `${label} appears among the attempts`);
    assert.ok(r.attempts.length >= 5, `every route is recorded: ${r.attempts.length}`);
  });
});

test('a module that does not export a function is reported as that, not called', async () => {
  // A file that loads but exports the wrong shape — what a mismatched engine pair looks like.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'solivy-ocr-bad-'));
  try {
    fs.writeFileSync(path.join(dir, 'tesseract-core-lstm.wasm.js'), 'module.exports = { notAFactory: true };');
    fs.writeFileSync(path.join(dir, 'tesseract-core-lstm.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    fs.mkdirSync(path.join(dir, 'tessdata'));
    fs.copyFileSync(path.resolve(__dirname, '..', '..', 'vendor', 'tesseract-wasm', 'tessdata', 'eng.traineddata'), path.join(dir, 'tessdata', 'eng.traineddata'));
    const previousDir = process.env.SOLIVY_GRN_OCR_WASM_DIR;
    process.env.SOLIVY_GRN_OCR_WASM_DIR = dir;
    try {
      await withRoutes(null, async (m) => {
        const r = await m.engineSelfTest();
        assert.equal(r.ok, false);
        assert.match(String(r.error), /did not export a function|could not be loaded/i, String(r.error));
        assert.ok(!/undefined is not a function/i.test(String(r.error)), String(r.error));
      });
    } finally {
      if (previousDir === undefined) delete process.env.SOLIVY_GRN_OCR_WASM_DIR; else process.env.SOLIVY_GRN_OCR_WASM_DIR = previousDir;
    }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
});

test('the engine can be checked from the application without uploading a document', async () => {
  const session = await app.adminSession('LIVE');
  const r = await app.call('/api/grn', { cookie: session.cookie, query: { selftest: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.engine.kind, 'bundled-wasm');
  assert.equal(r.json.engine.available, true);
  assert.deepEqual(r.json.engine.languages, ['eng']);
  assert.match(String(r.json.version), /^\d+\.\d+/, `the engine's version: ${r.json.version}`);
  assert.ok(r.json.load_route, `and how it was loaded: ${r.json.load_route}`);
  assert.deepEqual(r.json.load_attempts, [], 'with nothing having failed');
  assert.equal(r.json.error, null);
  assert.ok(String(r.json.node).startsWith('v'), 'the Node version is reported for support');
  assert.ok(String(r.json.platform).includes('-'), 'as is the platform');
  // A diagnostic must not create anything.
  assert.equal(app.expectOk(await app.call('/api/data', { cookie: session.cookie })).purchases.length, 0);
});

test('a failing engine makes the self-test say so, with the attempts, and answers 503', async () => {
  const session = await app.adminSession('LIVE');
  const previous = process.env.SOLIVY_GRN_OCR_WASM_DIR;
  process.env.SOLIVY_GRN_OCR_WASM_DIR = path.join(path.sep, 'solivy-no-such-folder');
  try {
    const r = await app.call('/api/grn', { cookie: session.cookie, query: { selftest: 1 } });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.engine.available, false);
    assert.match(String(r.json.engine.reason), /missing from|SOLIVY_GRN_OCR_WASM_DIR/i, String(r.json.engine.reason));
    assert.ok(String(r.json.error || '').length > 0, 'and an error to show the user');
  } finally {
    if (previous === undefined) delete process.env.SOLIVY_GRN_OCR_WASM_DIR; else process.env.SOLIVY_GRN_OCR_WASM_DIR = previous;
  }
});
