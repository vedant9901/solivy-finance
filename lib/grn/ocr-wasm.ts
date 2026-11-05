import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * The OCR engine that ships with SOLIVY (v2.11.0).
 *
 * A scanned GRN used to need Tesseract installed on the machine, on the PATH or named in an
 * environment variable. On a normal Windows installation it was not there, so scanned pages could
 * only be read by eye. That requirement is gone: `vendor/tesseract-wasm/` carries a WebAssembly
 * build of Tesseract (Apache-2.0 — provenance, checksums and notices in that folder's NOTICE.md)
 * which runs inside SOLIVY's own Node process on any platform.
 *
 *  - **Nothing to install.** No `.exe`, no PATH entry, no environment variable, no architecture to
 *    match: the same two files work in development and in an installed copy.
 *  - **Nothing leaves the machine.** The engine is a local WebAssembly module. No cloud OCR, no
 *    telemetry, no network call of any kind — recognition works with the network disconnected.
 *  - **Paths are resolved from this module's own location**, never from the working directory and
 *    never from the PATH, so it behaves the same however SOLIVY is started.
 *
 * The engine is created once per process and reused across pages, because `Init` costs far more
 * than a page does. Page images come from `pdf-native.ts` and are handed to Leptonica as they are
 * (JPEG, PNG, TIFF), so Poppler is not involved.
 */
export type WasmPageResult = { text: string; confidence: number; ms: number };
/** One recognised word, with its box on the page image, for locating regions by their text. */
export type WasmWord = { text: string; x: number; y: number; width: number; height: number; confidence: number; line: number };
export type WasmRect = { x: number; y: number; width: number; height: number };
export type WasmRegionRequest = { name: string; rect: WasmRect; psm?: number };
export type WasmRegionRead = { name: string; rect: WasmRect; text: string; confidence: number; words: WasmWord[]; ms: number; skipped: string | null };
export type WasmPageRead = { text: string; confidence: number; words: WasmWord[]; width: number; height: number; regions: WasmRegionRead[]; ms: number };
export type WasmEngineInfo = {
  available: boolean;
  /** Why it is unavailable, in words a user can act on. */
  reason: string | null;
  dir: string;
  core: string | null;
  tessdata: string | null;
  languages: string[];
  version: string | null;
};

const LANG = () => String(process.env.SOLIVY_GRN_OCR_LANG || 'eng');
/** Tesseract's own page-segmentation mode; 4 (single column of variable sizes) was measured best. */
const PSM = () => Number(process.env.SOLIVY_GRN_OCR_PSM || 4);

/** The bundled engine's folder, found from this file rather than from the process's directory. */
export function vendorDir(): string {
  const configured = process.env.SOLIVY_GRN_OCR_WASM_DIR;
  if (configured) return path.resolve(configured);
  // lib/grn/ocr-wasm.ts → <app>/vendor/tesseract-wasm. In a bundled server build this file may sit
  // deeper, so a few parents are tried before giving up.
  const here = __dirname;
  const candidates = [
    path.resolve(here, '..', '..', 'vendor', 'tesseract-wasm'),
    path.resolve(here, '..', '..', '..', 'vendor', 'tesseract-wasm'),
    path.resolve(here, '..', '..', '..', '..', 'vendor', 'tesseract-wasm'),
    path.resolve(process.cwd(), 'vendor', 'tesseract-wasm'),      // last resort only
  ];
  for (const c of candidates) { try { if (fs.existsSync(path.join(c, CORE_FILE))) return c; } catch { /* unreadable */ } }
  return candidates[0];
}

const CORE_FILE = 'tesseract-core-lstm.wasm.js';
const WASM_FILE = 'tesseract-core-lstm.wasm';

/** What is on disk, for diagnostics — cheap, and it never loads the engine. */
export function engineInfo(): WasmEngineInfo {
  const dir = vendorDir();
  const core = path.join(dir, CORE_FILE);
  const wasm = path.join(dir, WASM_FILE);
  const tessdata = path.join(dir, 'tessdata');
  const out: WasmEngineInfo = { available: false, reason: null, dir, core: null, tessdata: null, languages: [], version: loaded?.version ?? null };
  if (!fs.existsSync(core) || !fs.existsSync(wasm)) {
    out.reason = `The bundled OCR engine is missing from ${dir} (expected ${CORE_FILE} and ${WASM_FILE}). Reinstall SOLIVY, or set SOLIVY_GRN_OCR_WASM_DIR to the folder that holds them.`;
    return out;
  }
  out.core = core;
  if (!fs.existsSync(tessdata)) {
    out.reason = `The bundled OCR engine is present but its language folder ${tessdata} is missing.`;
    return out;
  }
  out.tessdata = tessdata;
  try { out.languages = fs.readdirSync(tessdata).filter((f) => f.endsWith('.traineddata')).map((f) => f.replace(/\.traineddata$/, '')).sort(); } catch { /* unreadable */ }
  const wanted = LANG().split('+').map((l) => l.trim()).filter(Boolean);
  const missing = wanted.filter((l) => !out.languages.includes(l));
  if (missing.length) {
    out.reason = `Language data for ${missing.join(', ')} is not in ${tessdata} (it holds ${out.languages.join(', ') || 'nothing'}). Put <lang>.traineddata there, or set SOLIVY_GRN_OCR_LANG to a language that is present.`;
    return out;
  }
  out.available = true;
  return out;
}

type Loaded = { core: any; api: any; version: string; lang: string; dir: string };
let loaded: Loaded | null = null;
let loadFailed: string | null = null;
/** How the engine file was loaded, and what was tried — reported in the diagnostics panel. */
let loadRoute: string | null = null;
let loadAttempts: string[] = [];

/**
 * Load the engine's Emscripten module from an absolute path on disk, under any module system.
 *
 * This is the one place that must survive being bundled. SOLIVY runs as a Next.js server build,
 * which rewrites module code: a bare `require` is replaced by the bundler's own loader (which would
 * try to pull a 3.9 MB file into the bundle and lose the sibling `.wasm`), a `new Function` body
 * sees only global scope (where `require` does not exist under ESM), and an `import` of
 * `node:module` can come back without its named exports — in which case `createRequire(…)` is a
 * call on `undefined`. That last case is what produced "undefined is not a function" on a real
 * installation, with the engine never loading and every page reported as unrecognisable.
 *
 * So every route is tried in turn, each one guarded by a `typeof` check rather than assumed to
 * exist, and the outcome of each attempt is recorded. If they all fail, the error names what was
 * tried and why each failed — never a bare type error from deep inside a loader.
 */
async function loadFactory(file: string): Promise<(opts: any) => Promise<any>> {
  const attempts: string[] = [];
  // Which routes may be used. Everything, unless SOLIVY_GRN_OCR_LOAD_ROUTES names a subset — which
  // lets each fallback be exercised on its own (the tests do exactly that, so the fallbacks are
  // known to work rather than assumed to), and lets an odd build be pinned to a route that works.
  const allowed = String(process.env.SOLIVY_GRN_OCR_LOAD_ROUTES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const may = (route: string) => !allowed.length || allowed.includes(route);
  const unwrap = (m: any) => (m && typeof m === 'object' && typeof m.default === 'function' ? m.default : m);
  const ok = (candidate: any, route: string) => {
    const fn = unwrap(candidate);
    if (typeof fn !== 'function') { attempts.push(`${route}: loaded, but the file did not export a function (got ${typeof fn})`); return null; }
    loadRoute = route; loadAttempts = attempts;
    return fn as (opts: any) => Promise<any>;
  };

  // 1. createRequire from node:module — the correct route in both CommonJS and ESM, when the
  //    bundler has left the import intact.
  try {
    if (may('createRequire') && typeof createRequire === 'function') {
      const base = typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'index.js');
      const hit = ok(createRequire(base)(file), 'createRequire(node:module)');
      if (hit) return hit;
    } else attempts.push(may('createRequire') ? 'createRequire(node:module): the import did not provide it (this is what a bundled build can do)' : 'createRequire(node:module): not in SOLIVY_GRN_OCR_LOAD_ROUTES');
  } catch (e: any) { attempts.push(`createRequire(node:module): ${String(e?.message || e).slice(0, 140)}`); }

  // 2. The same, but asking for node:module at run time so a rewritten static import cannot
  //    remove it.
  try {
    const mod: any = may('import-module') ? await import('node:' + 'module') : null;
    const create = mod?.createRequire || mod?.default?.createRequire;
    if (typeof create === 'function') {
      const base = typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'index.js');
      const hit = ok(create(base)(file), 'await import(node:module).createRequire');
      if (hit) return hit;
    } else attempts.push(may('import-module') ? 'await import(node:module): no createRequire on the namespace' : 'await import(node:module): not in SOLIVY_GRN_OCR_LOAD_ROUTES');
  } catch (e: any) { attempts.push(`await import(node:module): ${String(e?.message || e).slice(0, 140)}`); }

  // 3. The bundler's own require, where this module really is CommonJS.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (may('require') && typeof require === 'function') {
      const hit = ok(require(/* webpackIgnore: true */ file), 'require');
      if (hit) return hit;
    } else attempts.push(may('require') ? 'require: not defined in this module scope' : 'require: not in SOLIVY_GRN_OCR_LOAD_ROUTES');
  } catch (e: any) { attempts.push(`require: ${String(e?.message || e).slice(0, 140)}`); }

  // 4. A require fetched past the bundler, for a build that rewrote the identifier above.
  try {
    const raw = may('eval-require') ? eval('typeof require === "function" ? require : null') : null;
    if (typeof raw === 'function') {
      const hit = ok(raw(file), 'eval(require)');
      if (hit) return hit;
    } else attempts.push(may('eval-require') ? 'eval(require): not available' : 'eval(require): not in SOLIVY_GRN_OCR_LOAD_ROUTES');
  } catch (e: any) { attempts.push(`eval(require): ${String(e?.message || e).slice(0, 140)}`); }

  // 5. A dynamic import of the file itself, by URL — the ESM route of last resort.
  try {
    if (may('import-url')) {
      const url = 'file://' + (path.isAbsolute(file) ? file : path.resolve(file));
      const hit = ok(await import(/* webpackIgnore: true */ url), 'await import(file url)');
      if (hit) return hit;
    } else attempts.push('await import(file url): not in SOLIVY_GRN_OCR_LOAD_ROUTES');
  } catch (e: any) { attempts.push(`await import(file url): ${String(e?.message || e).slice(0, 140)}`); }

  loadAttempts = attempts;
  throw new Error(
    `The bundled OCR engine at ${file} could not be loaded by this build of SOLIVY. ` +
    `Each way of loading it was tried and failed: ${attempts.join(' | ')}. ` +
    'The file is present; this is a module-loading problem, not a missing engine. Set SOLIVY_GRN_OCR_WASM_DIR to the folder holding it if it has been moved, and report these messages.',
  );
}

/**
 * Create the engine, or return the one already created. Loading the WebAssembly module and the
 * language data takes about a second; a page takes a few seconds after that.
 */
async function engine(): Promise<Loaded> {
  const lang = LANG();
  const info = engineInfo();
  // An engine already loaded is reused — but only when it is still the engine the current
  // settings point at. If the folder or the language has changed, the cached one is for something
  // else and must be let go, so that a diagnostic never reports a stale success.
  if (loaded && loaded.lang === lang && loaded.dir === info.dir) return loaded;
  if (loaded) disposeEngine();
  if (loadFailed) throw new Error(loadFailed);
  if (!info.available) { loadFailed = info.reason || 'The bundled OCR engine is not available.'; throw new Error(loadFailed); }

  const factory = await loadFactory(info.core!);
  const core = await factory({
    locateFile: (file: string) => path.join(info.dir, file),
    // The engine prints progress and layout notes; they are not errors and must not reach stderr.
    print: () => {}, printErr: () => {},
  });
  // Each of these is checked before it is used. A build whose exports differ must say which part
  // is missing; "undefined is not a function" tells a user nothing they can act on.
  const need = (value: any, what: string) => {
    if (!value) { loadFailed = `The bundled OCR engine loaded (via ${loadRoute}) but does not provide ${what}. The engine files in ${info.dir} may be a mismatched pair; reinstall SOLIVY.`; throw new Error(loadFailed); }
    return value;
  };
  need(core?.FS?.writeFile, 'a filesystem to pass the language data through');
  need(typeof core?.TessBaseAPI === 'function' ? core.TessBaseAPI : null, 'the TessBaseAPI interface');
  for (const l of lang.split('+').map((x) => x.trim()).filter(Boolean)) {
    core.FS.writeFile(`/${l}.traineddata`, fs.readFileSync(path.join(info.tessdata!, `${l}.traineddata`)));
  }
  const api = new core.TessBaseAPI();
  for (const [m, what] of [['Init', 'Init'], ['SetImageFile', 'SetImageFile'], ['Recognize', 'Recognize'], ['GetUTF8Text', 'GetUTF8Text'], ['SetPageSegMode', 'SetPageSegMode']] as const) {
    need(typeof api[m] === 'function' ? api[m] : null, `the ${what} method`);
  }
  const version = String(api.Version?.() || 'unknown');
  // OEM 1 = the LSTM engine, which is the only one in this build.
  const status = api.Init('/', lang, 1);
  if (status !== 0) {
    try { api.End(); } catch { /* already gone */ }
    loadFailed = `The bundled OCR engine would not initialise with language "${lang}" (status ${status}). The language data in ${info.tessdata} may be corrupt; reinstall SOLIVY.`;
    throw new Error(loadFailed);
  }
  api.SetPageSegMode(PSM());
  loaded = { core, api, version, lang, dir: info.dir };
  return loaded;
}

/**
 * Recognise one page image. `bytes` is the image exactly as it sits in the PDF — Leptonica decodes
 * JPEG, PNG and TIFF itself. `dpi`, where the page geometry gives it, stops the engine guessing at
 * the scale.
 */
export async function recogniseImage(bytes: Buffer, opts: { dpi?: number | null } = {}): Promise<WasmPageResult> {
  const { core, api } = await engine();
  const started = Date.now();
  try {
    core.FS.writeFile('/input', bytes);
    if (api.SetImageFile(1, 0) === 1) throw new Error('the image could not be decoded');
    if (opts.dpi && opts.dpi >= 70 && opts.dpi <= 1200) { try { api.SetSourceResolution(Math.round(opts.dpi)); } catch { /* older build */ } }
    api.Recognize(null);
    const text = String(api.GetUTF8Text() || '');
    let confidence = -1;
    try { confidence = Number(api.MeanTextConf()); } catch { /* older build */ }
    return { text, confidence: Number.isFinite(confidence) ? confidence : -1, ms: Date.now() - started };
  } finally {
    // The page is cleared either way, so a failure cannot leak into the next page's result, and the
    // temporary image does not stay in the engine's memory.
    try { api.Clear(); } catch { /* nothing to clear */ }
    try { core.FS.unlink('/input'); } catch { /* already gone */ }
  }
}

/**
 * One recognition of a page, plus whatever further passes the caller asks for over regions of the
 * same image (v2.11.1).
 *
 * The first pass is the whole page. Its word boxes are then handed to `plan`, which returns the
 * regions worth reading again — located from the words themselves, never from pixel coordinates
 * fixed for one document. Each region is read with `SetRectangle` on the image **already loaded**,
 * so no cropping, no image copy and no re-decode: the cost of a region is a recognition, not a new
 * page. `plan` is given the page size so it can work in fractions of the page.
 *
 * Why it helps: the whole-page pass lays the page out as one document, and a narrow table column
 * can come back wrapped across lines or merged with its neighbour. Reading the table on its own,
 * with a page-segmentation mode suited to a block, resolves those cells; and the word boxes let the
 * caller rebuild a row by column position instead of guessing from the order of the text.
 */
export async function recognisePage(
  bytes: Buffer,
  opts: {
    dpi?: number | null;
    psm?: number;
    /**
     * The image's true pixel size, where the caller knows it (the PDF carries it). It is used only
     * to clamp a region to the image — never as the basis for the geometry. Regions are measured
     * against the **extent of the print**, which the word boxes give in the same pixel space: a
     * page whose content sits in its top fifth must have its table found relative to that content,
     * not to a sheet of mostly blank paper.
     */
    imageSize?: { width: number; height: number } | null;
    plan?: (words: WasmWord[], size: { width: number; height: number }, text: string) => WasmRegionRequest[];
  } = {},
): Promise<WasmPageRead> {
  const { core, api } = await engine();
  const started = Date.now();
  try {
    core.FS.writeFile('/input', bytes);
    if (api.SetImageFile(1, 0) === 1) throw new Error('the image could not be decoded');
    if (opts.dpi && opts.dpi >= 70 && opts.dpi <= 1200) { try { api.SetSourceResolution(Math.round(opts.dpi)); } catch { /* older build */ } }

    const basePsm = opts.psm ?? PSM();
    api.SetPageSegMode(basePsm);
    api.Recognize(null);
    const text = String(api.GetUTF8Text() || '');
    const confidence = meanConf(api);
    const words = wordsFrom(api);
    const size = pageSize(words);                                  // the extent of the print
    const bounds = opts.imageSize && opts.imageSize.width > 0 && opts.imageSize.height > 0
      ? { width: Math.max(opts.imageSize.width, size.width), height: Math.max(opts.imageSize.height, size.height) }
      : size;

    const regions: WasmRegionRead[] = [];
    for (const want of (opts.plan ? opts.plan(words, size, text) : []).slice(0, MAX_REGIONS)) {
      const rect = clampRect(want.rect, bounds);
      if (!rect) { regions.push({ name: want.name, rect: want.rect, text: '', confidence: -1, words: [], ms: 0, skipped: 'the region fell outside the page' }); continue; }
      const regionStarted = Date.now();
      try {
        api.SetPageSegMode(want.psm ?? 6);     // 6 = a single uniform block, which suits a table
        api.SetRectangle(rect.x, rect.y, rect.width, rect.height);
        api.Recognize(null);
        regions.push({ name: want.name, rect, text: String(api.GetUTF8Text() || ''), confidence: meanConf(api), words: wordsFrom(api), ms: Date.now() - regionStarted, skipped: null });
      } catch (e: any) {
        regions.push({ name: want.name, rect, text: '', confidence: -1, words: [], ms: Date.now() - regionStarted, skipped: String(e?.message || e).slice(0, 120) });
      }
    }
    // Put the engine back on the whole page, so the next page is not read through this page's box.
    try { api.SetRectangle(0, 0, bounds.width || 1, bounds.height || 1); } catch { /* nothing set */ }
    api.SetPageSegMode(PSM());

    return { text, confidence, words, width: size.width, height: size.height, regions, ms: Date.now() - started };
  } finally {
    try { api.Clear(); } catch { /* nothing to clear */ }
    try { core.FS.unlink('/input'); } catch { /* already gone */ }
  }
}

/** A hard ceiling on the extra passes per page, so a page cannot become an unbounded loop. */
const MAX_REGIONS = Number(process.env.SOLIVY_GRN_OCR_MAX_REGIONS || 4);

function meanConf(api: any): number {
  try { const c = Number(api.MeanTextConf()); return Number.isFinite(c) ? c : -1; } catch { return -1; }
}

/** Word boxes and per-word confidence, from the engine's TSV output. */
function wordsFrom(api: any): WasmWord[] {
  let tsv = '';
  try { tsv = String(api.GetTSVText(0) || ''); } catch { return []; }
  const out: WasmWord[] = [];
  for (const line of tsv.split('\n')) {
    const c = line.split('\t');
    // level page block par line word left top width height conf text
    if (c.length < 12 || c[0] !== '5') continue;
    const [left, top, width, height, conf] = [c[6], c[7], c[8], c[9], c[10]].map(Number);
    const text = c[11];
    if (!text || !text.trim() || !Number.isFinite(left)) continue;
    out.push({ text, x: left, y: top, width, height, confidence: Number.isFinite(conf) ? conf : -1, line: Number(c[4]) });
  }
  return out;
}

/** The page's extent, taken from the words — the engine reports no page size of its own here. */
function pageSize(words: WasmWord[]): { width: number; height: number } {
  let width = 0; let height = 0;
  for (const w of words) { width = Math.max(width, w.x + w.width); height = Math.max(height, w.y + w.height); }
  return { width, height };
}

function clampRect(r: WasmRect, size: { width: number; height: number }): WasmRect | null {
  if (!size.width || !size.height) return null;
  const x = Math.max(0, Math.min(Math.round(r.x), size.width - 1));
  const y = Math.max(0, Math.min(Math.round(r.y), size.height - 1));
  const width = Math.max(1, Math.min(Math.round(r.width), size.width - x));
  const height = Math.max(1, Math.min(Math.round(r.height), size.height - y));
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

/** Release the engine. Used by tests; a normal run keeps it for the life of the process. */
export function disposeEngine() {
  try { loaded?.api?.End(); } catch { /* already gone */ }
  loaded = null; loadFailed = null;
}

/** For diagnostics: the engine's reported version, once it has been loaded. */
export function loadedVersion(): string | null { return loaded?.version ?? null; }

/** How the engine file was loaded, what was tried, and why it failed — for the diagnostics panel. */
export function loadDiagnostics(): { route: string | null; attempts: string[]; failed: string | null } {
  return { route: loadRoute, attempts: [...loadAttempts], failed: loadFailed };
}

/**
 * Load the engine and recognise a tiny built-in image, so a machine can be checked without a
 * document. Used by the diagnostics panel and by the tests; it reports the exact failure instead
 * of leaving a user with "nothing could be read".
 */
export async function engineSelfTest(): Promise<{ ok: boolean; version: string | null; route: string | null; attempts: string[]; error: string | null; ms: number }> {
  const started = Date.now();
  // What is on disk now decides the answer. A diagnostic that reported an engine loaded earlier in
  // the process as a success, while the configured folder has no engine in it, would be worse than
  // no diagnostic at all.
  const info = engineInfo();
  if (!info.available) {
    return { ok: false, version: null, route: loadRoute, attempts: [...loadAttempts], error: info.reason || 'The bundled OCR engine is not available.', ms: Date.now() - started };
  }
  try {
    const { version } = await engine();
    return { ok: true, version, route: loadRoute, attempts: [...loadAttempts], error: null, ms: Date.now() - started };
  } catch (e: any) {
    return { ok: false, version: null, route: loadRoute, attempts: [...loadAttempts], error: String(e?.message || e), ms: Date.now() - started };
  }
}
