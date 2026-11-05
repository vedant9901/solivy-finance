import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPdf, pageImage as nativePageImage, type NativeDocument } from './pdf-native';
import { recogniseImage, recognisePage, engineInfo, loadedVersion, loadDiagnostics, type WasmEngineInfo } from './ocr-wasm';
import { looksLikeGrn, looksLikeBill, grnRegions, billRegions, rebuildTable, grnRowLines, combinePasses, coverageOf } from './regions';
import { parseGrnPage, parseBillPage } from './parse';

/** The parser is the judge of what a page yielded, so the gate uses the same rules as the draft. */
const PARSERS = { grn: parseGrnPage, bill: parseBillPage };

/**
 * The GRN table's column labels, as printed on the page. The second pass finds these words and
 * takes each column's span from where they actually sit, so the row can be rebuilt by position
 * rather than by the order the text happens to come out in.
 */
const GRN_TABLE_HEADERS = [
  ['sample', 'no'], ['grn', 'date'], ['truck', 'no'], ['po', 'supplier'], ['bags'],
  ['recd', 'net'], ['freight'], ['load'], ['rokdi'], ['moist'], ['deduction'],
];

/**
 * Getting text and page images out of a GRN / party-bill PDF (v2.10.2).
 *
 * v2.10.0 handed every step to external tools — poppler for the page count, the text layer and the
 * page images, tesseract for scans — so a machine with neither could do nothing at all: the wizard
 * could only name what was missing. That is now fixed. `pdf-native.ts` reads the PDF in plain
 * JavaScript, with no tools and nothing installed, and this module uses it as the primary path:
 *
 *  - the **page count** is the document's real one, from its page tree (never a guess);
 *  - a **text layer** is decoded directly, so a digitally produced GRN or Tally bill imports
 *    exactly, anywhere, with no tools and no recognition at all;
 *  - the **page image** of a scan is lifted out of the file, so the pages are always on screen and
 *    the values can always be typed in against them.
 *
 * External tools remain **optional accelerators**, never requirements:
 *  - `pdftotext`, where present, is preferred for a text layer because `-layout` preserves column
 *    spacing better than a raw content-stream read;
 *  - `tesseract` alone is now enough to recognise a scan — the page image comes from the native
 *    reader, so poppler is no longer needed for that;
 *  - `pdftoppm`, where present, renders a page that carries no embedded image (a vector-only page).
 *
 * Nothing leaves the machine: no cloud OCR, no upload of the document anywhere. A GRN and a party
 * bill carry a vendor's GSTIN, bank account and contact details.
 *
 * Settings measured on the supplied scan: 300 dpi and `--psm 4` (column-aware) recover the GRN
 * table row in full; the default 150 dpi / `--psm 6` lost the numeric cells. The embedded page
 * images in that document are 2558×3777, i.e. already at that resolution, so they are fed to
 * recognition as they are.
 */
export const OCR_DPI = Number(process.env.SOLIVY_GRN_OCR_DPI || 300);
export const OCR_PSM = String(process.env.SOLIVY_GRN_OCR_PSM || '4');
/**
 * A page counts as having a usable text layer above this many non-space characters. The supplied
 * scan yields zero, while a genuinely sparse text page — a short note, a continuation sheet — must
 * not be sent for recognition it does not need.
 */
export const TEXT_LAYER_MIN_CHARS = Number(process.env.SOLIVY_GRN_TEXT_MIN || 12);

export type PageText = { page: number; text: string; source: 'text-layer' | 'ocr' };
/** Which engine read a page, how long it took and how sure it was — for the diagnostics panel. */
export type PageDiagnostic = {
  page: number;
  status: 'text-layer' | 'recognised' | 'failed' | 'not-attempted';
  engine: 'built-in-reader' | 'pdftotext' | 'bundled-wasm' | 'system-tesseract' | null;
  ms: number;
  chars: number;
  confidence: number | null;
  detail: string | null;
  /** The page image handed to recognition, in pixels. */
  image?: { width: number; height: number } | null;
  /** v2.11.1: the second-pass regions this page needed, with what each one produced. */
  regions?: Array<{ name: string; rect: { x: number; y: number; width: number; height: number }; chars: number; confidence: number | null; ms: number; skipped: string | null }>;
  /** Which required fields the first pass left missing, and so why a region pass was run. */
  second_pass_reason?: string | null;
};
export type EngineDiagnostic = {
  /** The engine that recognition would use, or did use. */
  kind: 'bundled-wasm' | 'system-tesseract' | 'none';
  version: string | null;
  path: string | null;
  tessdata: string | null;
  languages: string[];
  language_requested: string;
  psm: number;
  /** Set when no engine is usable; it names what is wrong and what to do. */
  reason: string | null;
  /** v2.11.2: how the engine file was loaded, and what was tried if it could not be. */
  load_route?: string | null;
  load_attempts?: string[];
};
export type Extraction = {
  pages: PageText[];
  page_count: number;
  sha256: string;
  bytes: number;
  source: 'text-layer' | 'ocr' | 'none';
  tools: { pdftotext: string | null; pdftoppm: string | null; tesseract: string | null };
  /** Pages this build can show as an image, so values can be read off the page and typed in. */
  viewable_pages: number[];
  /** True when the page count, the text layer or a page image came from the built-in reader. */
  native: boolean;
  /** Per-page record of what happened, in page order. */
  diagnostics: PageDiagnostic[];
  engine: EngineDiagnostic;
  ms: number;
  notes: string[];
};

/**
 * Where a tool may be, beyond the PATH. On Windows poppler and tesseract are routinely installed
 * without their folder being added to the PATH, which is the single commonest reason the earlier
 * build reported them missing on a machine that had them.
 */
function extraSearchDirs(): string[] {
  if (process.platform !== 'win32') return ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin'];
  const roots = [process.env['ProgramFiles'] || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env['LOCALAPPDATA'] || '', process.env['ProgramData'] || 'C:\\ProgramData', 'C:\\'].filter(Boolean);
  const leaves = ['Tesseract-OCR', 'poppler', 'poppler\\Library\\bin', 'poppler\\bin', 'Programs\\Tesseract-OCR', 'chocolatey\\bin', 'scoop\\shims', 'tools\\poppler\\Library\\bin'];
  const dirs: string[] = [];
  for (const root of roots) for (const leaf of leaves) dirs.push(path.join(root, leaf));
  // A poppler release unzipped anywhere under a common root keeps its Library\bin layout.
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^(poppler|Release-)/i.test(entry.name)) continue;
        dirs.push(path.join(root, entry.name, 'Library', 'bin'), path.join(root, entry.name, 'bin'));
      }
    } catch { /* unreadable root */ }
  }
  return dirs;
}

function toolPath(envVar: string, name: string): string | null {
  const configured = process.env[envVar];
  if (configured) return fs.existsSync(configured) ? configured : null;
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...extraSearchDirs()];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const suffix of process.platform === 'win32' ? ['.exe', ''] : ['', '.exe']) {
      const candidate = path.join(dir, name + suffix);
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* unreadable entry */ }
    }
  }
  return null;
}

export function availableTools() {
  return {
    pdftotext: toolPath('SOLIVY_PDFTOTEXT', 'pdftotext'),
    pdftoppm: toolPath('SOLIVY_PDFTOPPM', 'pdftoppm'),
    tesseract: toolPath('SOLIVY_TESSERACT', 'tesseract'),
  };
}

function run(bin: string, args: string[], cwd?: string) {
  return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true });
}

/** Split `pdftotext` output into pages: it separates them with a form feed. */
function splitPages(text: string): string[] {
  return text.split('\f').map((p) => p.replace(/\r/g, '')).filter((p, i, a) => i < a.length - 1 || p.trim().length > 0);
}

const enough = (text: string) => text.replace(/\s/g, '').length >= TEXT_LAYER_MIN_CHARS;

/**
 * Text for every page. The built-in reader supplies the page count and a first reading of every
 * page with no tools at all; `pdftotext` improves on it where it is installed; only a page that
 * neither can read is sent for recognition.
 */
/** How long recognition may spend on one document before it stops and says so. */
export const ocrBudgetMs = () => Number(process.env.SOLIVY_GRN_OCR_BUDGET_MS || 180_000);

/** Which engine recognition should use: the bundled one unless told otherwise. */
function chooseEngine(tools: ReturnType<typeof availableTools>): { kind: 'bundled-wasm' | 'system-tesseract' | 'none'; wasm: WasmEngineInfo; reason: string | null } {
  const preference = String(process.env.SOLIVY_GRN_OCR_ENGINE || 'bundled').toLowerCase();
  const wasm = engineInfo();
  if (preference === 'system') {
    if (tools.tesseract) return { kind: 'system-tesseract', wasm, reason: null };
    return wasm.available
      ? { kind: 'bundled-wasm', wasm, reason: 'SOLIVY_GRN_OCR_ENGINE asked for the system Tesseract, which was not found; the bundled engine was used instead.' }
      : { kind: 'none', wasm, reason: `SOLIVY_GRN_OCR_ENGINE asked for the system Tesseract, which was not found, and ${wasm.reason}` };
  }
  if (preference === 'system-first' || preference === 'auto') {
    if (tools.tesseract) return { kind: 'system-tesseract', wasm, reason: null };
  }
  // The default. The bundled engine ships with SOLIVY, is the version these tests were run
  // against, and needs nothing installed.
  if (wasm.available) return { kind: 'bundled-wasm', wasm, reason: null };
  if (tools.tesseract) return { kind: 'system-tesseract', wasm, reason: `${wasm.reason} The Tesseract installed on this machine was used instead.` };
  return { kind: 'none', wasm, reason: wasm.reason };
}

/**
 * Text for every page. The built-in reader supplies the page count and a first reading of every
 * page with no tools at all; `pdftotext` improves on it where it is installed; a page neither can
 * read is recognised — by the engine that ships with SOLIVY, so this needs nothing installed.
 */
export async function extractPdfText(bytes: Buffer, opts: { maxPages?: number } = {}): Promise<Extraction> {
  const startedAll = Date.now();
  const tools = availableTools();
  const notes: string[] = [];
  const diagnostics = new Map<number, PageDiagnostic>();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const maxPages = Math.max(1, Math.min(60, opts.maxPages || 25));

  let doc: NativeDocument = { ok: false, pageCount: 0, pages: [], encrypted: false, note: '' };
  try { doc = readPdf(bytes, { maxPages, withImages: true }); }
  catch (e: any) { notes.push(`The built-in reader could not parse this PDF (${String(e?.message || e).slice(0, 120)}).`); }
  if (doc.note) notes.push(doc.note);

  // The real page count, from the page tree. Never the scan limit — reporting "20 pages" for a
  // two-page document, as an earlier build did, is a fabricated figure.
  const pageCount = doc.pageCount;
  const consider = pageCount ? Math.min(pageCount, maxPages) : 0;

  const best = new Map<number, string>();
  const readBy = new Map<number, PageDiagnostic['engine']>();
  for (const p of doc.pages) if (enough(p.text)) { best.set(p.page, p.text); readBy.set(p.page, 'built-in-reader'); }
  const nativeTextPages = best.size;

  if (tools.pdftotext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-grn-'));
    const file = path.join(dir, 'document.pdf');
    try {
      fs.writeFileSync(file, bytes);
      const layerPages = splitPages(run(tools.pdftotext, ['-layout', '-q', file, '-']));
      // Preferred where it reads the page: `-layout` keeps the column spacing the parser uses.
      for (let i = 0; i < Math.min(layerPages.length, consider || layerPages.length); i++) {
        if (enough(layerPages[i] || '')) { best.set(i + 1, layerPages[i]); readBy.set(i + 1, 'pdftotext'); }
      }
    } catch (e: any) {
      notes.push(`The embedded text layer could not be read by pdftotext (${String(e?.message || e).slice(0, 120)}); the built-in reader was used instead.`);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
  }

  const pages: PageText[] = [...best.entries()].map(([page, text]) => ({ page, text, source: 'text-layer' as const }));
  for (const [page, text] of best) diagnostics.set(page, { page, status: 'text-layer', engine: readBy.get(page) ?? 'built-in-reader', ms: 0, chars: text.replace(/\s/g, '').length, confidence: null, detail: null });

  const viewable: number[] = [];
  for (const p of doc.pages) if (p.images.length) viewable.push(p.page);
  for (const p of doc.pages) for (const n of p.imageNotes) notes.push(n);

  const needsOcr: number[] = [];
  for (let page = 1; page <= consider; page++) if (!best.has(page)) needsOcr.push(page);

  const chosen = chooseEngine(tools);
  // Only told to the user when a page actually needs recognition. A PDF with a text layer is read
  // exactly without any engine, and saying the OCR engine is missing would be alarming noise about
  // something that did not matter. It stays in `engine.reason` for the diagnostics panel either way.
  if (chosen.reason && needsOcr.length) notes.push(chosen.reason);
  const engine: EngineDiagnostic = {
    kind: chosen.kind,
    version: chosen.kind === 'bundled-wasm' ? loadedVersion() : tools.tesseract ? 'system' : null,
    path: chosen.kind === 'bundled-wasm' ? chosen.wasm.core : tools.tesseract,
    tessdata: chosen.kind === 'bundled-wasm' ? chosen.wasm.tessdata : null,
    languages: chosen.kind === 'bundled-wasm' ? chosen.wasm.languages : [],
    language_requested: String(process.env.SOLIVY_GRN_OCR_LANG || 'eng'),
    psm: Number(OCR_PSM),
    reason: chosen.kind === 'none' ? (chosen.reason || 'No OCR engine is available.') : null,
    load_route: null,
    load_attempts: [],
  };

  if (needsOcr.length && chosen.kind === 'none') {
    const canSee = needsOcr.filter((p) => viewable.includes(p));
    notes.push(
      `${needsOcr.length} of ${pageCount} page(s) are scanned images with no text layer and no OCR engine could be used. ${engine.reason} ` +
      (canSee.length
        ? `Page ${canSee.join(', ')} ${canSee.length === 1 ? 'is' : 'are'} shown here at full scanner resolution — read the values off the page and type them into the fields, which calculate as normal.`
        : 'The pages could not be shown either, so the values must be entered from the printed document.'),
    );
    for (const page of needsOcr) diagnostics.set(page, { page, status: 'not-attempted', engine: null, ms: 0, chars: 0, confidence: null, detail: engine.reason });
  } else if (needsOcr.length) {
    const ran = chosen.kind as 'bundled-wasm' | 'system-tesseract';
    // The engine failing to load is one fault, not one per page: it is reported once.
    let engineLoadReported = false;
    const budget = ocrBudgetMs();
    const deadline = startedAll + budget;
    for (const page of needsOcr) {
      if (Date.now() > deadline) {
        diagnostics.set(page, { page, status: 'not-attempted', engine: ran, ms: 0, chars: 0, confidence: null, detail: `Recognition stopped after ${Math.round(budget / 1000)}s; this page was not attempted.` });
        notes.push(`Recognition ran out of its ${Math.round(budget / 1000)}-second budget, so page ${page} and any after it were not attempted. Raise SOLIVY_GRN_OCR_BUDGET_MS, or enter those pages by hand.`);
        break;
      }
      const started = Date.now();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-grn-ocr-'));
      // Declared out here so a failure can still report what the page got as far as.
      let imageSize: { width: number; height: number } | null = null;
      let regionDiag: NonNullable<PageDiagnostic['regions']> = [];
      let secondPassReason: string | null = null;
      try {
        // The page's own embedded image is the scanner's original and needs nothing installed; its
        // resolution is worked out from the page size so recognition is told the scale rather than
        // guessing at it. A vector-only page has no image, and is rendered by pdftoppm if present.
        const native = doc.pages.find((p) => p.page === page);
        const embedded = native && native.images.length ? [...native.images].sort((a, b) => b.width * b.height - a.width * a.height)[0] : null;
        let image: { bytes: Buffer; file: string | null; dpi: number | null; size: { width: number; height: number } | null } | null = null;
        if (embedded && native) {
          const inches = native.width / 72;
          image = { bytes: embedded.bytes, file: null, dpi: inches > 1 ? Math.round(embedded.width / inches) : null, size: { width: embedded.width, height: embedded.height } };
        } else if (tools.pdftoppm) {
          const file = path.join(dir, 'document.pdf');
          fs.writeFileSync(file, bytes);
          run(tools.pdftoppm, ['-r', String(OCR_DPI), '-png', '-f', String(page), '-l', String(page), file, path.join(dir, 'p')], dir);
          const found = fs.readdirSync(dir).find((f) => f.startsWith('p-') && f.endsWith('.png'));
          if (found) image = { bytes: fs.readFileSync(path.join(dir, found)), file: path.join(dir, found), dpi: OCR_DPI, size: null };
        }
        if (!image) {
          const detail = `This page carries no embedded image and could not be rendered for recognition${tools.pdftoppm ? '' : ' (pdftoppm was not found; install poppler-utils or set SOLIVY_PDFTOPPM)'}.`;
          notes.push(`Page ${page}: ${detail}`);
          diagnostics.set(page, { page, status: 'failed', engine: ran, ms: Date.now() - started, chars: 0, confidence: null, detail });
          continue;
        }

        let text = ''; let confidence: number | null = null;
        if (ran === 'bundled-wasm') {
          // Pass one is the whole page. A second pass over located regions follows only when the
          // page looks like a GRN or a bill and the first pass did not cover its required fields —
          // a narrow table column comes back wrapped or merged, which reading the table on its own
          // resolves. Regions are found from the words the first pass produced, never from pixel
          // coordinates fixed for one document.
          let firstPass = '';
          const read = await recognisePage(image.bytes, {
            dpi: image.dpi,
            imageSize: image.size,
            plan: (words, size, pageText) => {
              firstPass = pageText;
              const grn = looksLikeGrn(words); const bill = looksLikeBill(words);
              if (!grn && !bill) return [];
              // The gate: a page whose first pass already yields its required fields is not read
              // again. Only a page with something missing earns the extra passes.
              const before = coverageOf(pageText, PARSERS);
              if (!before.missing.length) {
                secondPassReason = `The first pass covered every required field of this ${before.kind === 'bill' ? 'supplier bill' : 'goods-receipt note'}, so no region was read again.`;
                return [];
              }
              secondPassReason = `The first pass left ${before.missing.join(', ')} unread on this ${before.kind === 'bill' ? 'supplier bill' : 'goods-receipt note'}, so its regions were read again.`;
              return grn ? grnRegions(words, size) : billRegions(words, size);
            },
          });
          imageSize = { width: read.width, height: read.height };
          confidence = read.confidence >= 0 ? read.confidence : null;
          text = read.text;
          regionDiag = read.regions.map((r) => ({ name: r.name, rect: r.rect, chars: r.text.replace(/\s/g, '').length, confidence: r.confidence >= 0 ? r.confidence : null, ms: r.ms, skipped: r.skipped }));

          if (read.regions.length) {
            // The GRN row is rebuilt by column from the table region's own word boxes, so a cell
            // the document wrapped over several lines arrives whole instead of as fragments.
            const rebuilt: Array<{ name: string; lines: string[] }> = [];
            const tableRegion = read.regions.find((r) => r.name === 'grn-receipt-table' && r.words.length);
            if (tableRegion) {
              const lines = grnRowLines(rebuildTable(tableRegion.words, GRN_TABLE_HEADERS));
              if (lines.length) rebuilt.push({ name: tableRegion.name, lines });
            }
            const combined = combinePasses(read.text, read.regions, rebuilt);
            // The guard: the extra passes stand only if they cover MORE than the first pass did.
            // A region that reads a table worse than the whole page is discarded, so a second pass
            // can add a missing cell but can never spoil a page that was already read correctly.
            const before = coverageOf(firstPass || read.text, PARSERS);
            const after = coverageOf(combined, PARSERS);
            if (after.score > before.score) {
              text = combined;
              secondPassReason = `${secondPassReason} The region passes recovered ${before.missing.filter((m) => !after.missing.includes(m)).join(', ') || 'further detail'}.`;
            } else {
              secondPassReason = `${secondPassReason} They added nothing the first pass had not already read (${before.score} of ${before.required.length} fields either way), so the first pass was kept.`;
            }
          }
        } else {
          const file = image.file || path.join(dir, `page-${page}.${embedded?.mime === 'image/png' ? 'png' : 'jpg'}`);
          if (!image.file) fs.writeFileSync(file, image.bytes);
          const args = [file, 'stdout', '--psm', OCR_PSM, '-l', engine.language_requested];
          if (image.dpi && image.dpi >= 70 && image.dpi <= 1200) args.push('--dpi', String(image.dpi));
          text = run(tools.tesseract!, args);
        }
        const chars = text.replace(/\s/g, '').length;
        if (!chars) {
          const detail = 'Recognition returned no characters for this page; it may be blank, upside down or too faint to read.';
          notes.push(`Page ${page}: ${detail}`);
          diagnostics.set(page, { page, status: 'failed', engine: ran, ms: Date.now() - started, chars: 0, confidence, detail, image: imageSize, regions: regionDiag, second_pass_reason: secondPassReason });
          continue;
        }
        pages.push({ page, text, source: 'ocr' });
        diagnostics.set(page, { page, status: 'recognised', engine: ran, ms: Date.now() - started, chars, confidence, detail: null, image: imageSize, regions: regionDiag, second_pass_reason: secondPassReason });
      } catch (e: any) {
        // The commonest cause is the engine itself failing to load, which is the same for every
        // page: say so once, with what was actually tried, instead of a bare type error per page.
        const load = loadDiagnostics();
        const detail = load.failed || (load.attempts.length && !load.route
          ? `The OCR engine could not be loaded by this build: ${load.attempts.join(' | ')}`
          : String(e?.message || e).slice(0, 300));
        if (!engineLoadReported) { notes.push(`Recognition could not run: ${detail}`); engineLoadReported = true; }
        else notes.push(`Page ${page} could not be recognised.`);
        diagnostics.set(page, { page, status: 'failed', engine: ran, ms: Date.now() - started, chars: 0, confidence: null, detail, image: imageSize, regions: regionDiag, second_pass_reason: secondPassReason });
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
    }
    if (engine.kind === 'bundled-wasm') {
      engine.version = loadedVersion();
      // How the engine file was actually loaded on this machine, and what failed if it was not.
      const load = loadDiagnostics();
      engine.load_route = load.route;
      engine.load_attempts = load.attempts;
      if (!engine.reason && load.failed) engine.reason = load.failed;
    }
  }

  pages.sort((a, b) => a.page - b.page);
  const anyOcr = pages.some((p) => p.source === 'ocr');
  const anyLayer = pages.some((p) => p.source === 'text-layer');
  if (anyOcr) notes.push(`Recognised on this machine from the page images, by the ${engine.kind === 'bundled-wasm' ? 'OCR engine built into SOLIVY' : 'Tesseract installed on this machine'}; nothing was sent anywhere. Every value is a suggestion to check against the page, not an authorised entry.`);
  if (anyLayer && nativeTextPages && !tools.pdftotext) notes.push('The text layer was read by the built-in reader, with no external tool.');

  return {
    pages,
    page_count: pageCount || pages.length,
    sha256,
    bytes: bytes.length,
    source: !pages.length ? 'none' : anyLayer ? 'text-layer' : 'ocr',
    tools: { pdftotext: tools.pdftotext ? 'found' : null, pdftoppm: tools.pdftoppm ? 'found' : null, tesseract: tools.tesseract ? 'found' : null },
    viewable_pages: viewable.sort((a, b) => a - b),
    native: doc.ok,
    diagnostics: [...diagnostics.values()].sort((a, b) => a.page - b.page),
    engine,
    ms: Date.now() - startedAll,
    notes,
  };
}

/**
 * An image of one page, for the review screen and for entering values by hand when recognition is
 * unavailable. The page's own embedded image is used where there is one — that is the scan itself,
 * at full resolution, and needs nothing installed; a vector-only page is rendered with pdftoppm
 * where that is present.
 */
export function renderPage(bytes: Buffer, page: number, dpi = 120): { bytes: Buffer; mime: string } | null {
  try {
    const native = nativePageImage(bytes, page);
    if (native) return { bytes: native.bytes, mime: native.mime };
  } catch { /* fall through to poppler */ }

  const tools = availableTools();
  if (!tools.pdftoppm) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-grn-img-'));
  try {
    const file = path.join(dir, 'document.pdf');
    fs.writeFileSync(file, bytes);
    run(tools.pdftoppm, ['-r', String(Math.max(60, Math.min(300, dpi))), '-png', '-f', String(page), '-l', String(page), file, path.join(dir, 'p')], dir);
    const image = fs.readdirSync(dir).find((f) => f.startsWith('p-') && f.endsWith('.png'));
    return image ? { bytes: fs.readFileSync(path.join(dir, image)), mime: 'image/png' } : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
}
