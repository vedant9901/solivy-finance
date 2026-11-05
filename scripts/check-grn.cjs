#!/usr/bin/env node
/**
 * v2.10.0 — the GRN pipeline keeps its safety properties: recognition never posts an entry,
 * never invents a value, and never writes a value that failed its own validation.
 */
const fs = require('node:fs');
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

const route = fs.readFileSync('app/api/grn/route.ts', 'utf8');
const page = fs.readFileSync('app/grn/page.tsx', 'utf8');
const parse = fs.readFileSync('lib/grn/parse.ts', 'utf8');
const draft = fs.readFileSync('lib/grn/draft.ts', 'utf8');
const extract = fs.readFileSync('lib/grn/extract.ts', 'utf8');
const access = fs.readFileSync('lib/api-access.ts', 'utf8');
const wizard = fs.readFileSync('app/components/GrnImportWizard.tsx', 'utf8');
const shell = fs.readFileSync('app/page.tsx', 'utf8');
const contract = fs.readFileSync('lib/grn/contract.ts', 'utf8');
const eligibility = fs.readFileSync('lib/sync-eligibility.ts', 'utf8');

check('the GRN endpoint never inserts a purchase, a payment or a ledger row',
  !/INSERT\s+INTO\s+(purchases|payments|ledger|account_transactions|money_in|money_out)/i.test(route));
check('the purchase is created by the existing purchase endpoint from the reviewed values',
  /fetch\('\/api\/purchases'/.test(page) && /window\.confirm/.test(page));
check('the entry cannot be saved until the blocking points are resolved',
  /blocking\.length > 0/.test(page) && /PARTY_REQUIRED/.test(draft) && /REQUIRED_FIELDS/.test(draft));
check('a party is never created without the user confirming it', /createParty/.test(page) && /Create the party/.test(page));

check('the rate unit is read from the bill, not assumed to be per kilogram',
  /unitToKg/.test(parse) && /RATE_CONVERTED/.test(draft) && /RATE_UNIT_UNKNOWN/.test(draft));
check('an unrecognised rate unit blocks instead of guessing', /code: 'RATE_UNIT_UNKNOWN', severity: 'blocking'/.test(draft));
check('the GRN moisture percentage is never written as a rupee deduction',
  /moisture: 0,/.test(draft) && /MOISTURE_REPORTED/.test(draft));
check('the moisture threshold is taken from the document, not invented', /MOISTURE CONTENT MORE TH\[AE\]N/.test(parse));
check('GSTIN and IFSC are validated, and a value that fails is not written into a record',
  /gstinIsValid/.test(draft) && /ifscIsValid/.test(draft) && /gst_as_read/.test(draft) && /ifsc_as_read/.test(draft));
check('the two pages are linked on the vehicle number, and a contradiction counts against the link',
  /is the tail of the bill's vehicle number/.test(parse) && /score -= 30/.test(parse));
check('duplicates are detected by document, sample number, invoice and vehicle+date',
  ['document', 'sample_no', 'invoice_no', 'truck_date'].every((k) => draft.includes(`'${k}'`)));
check('every proposed field carries a confidence and the evidence behind it',
  /confidence: 'high' \| 'medium' \| 'low'/.test(parse) && /evidence\[/.test(draft));

check('recognition runs locally; the document is never sent to an external service',
  !/https?:\/\//.test(extract.replace(/^\s*\*.*$/gm, '')) && /tesseract/.test(extract) && /Nothing leaves the machine/.test(extract));
check('a missing recognition tool is reported by name instead of failing silently',
  /was not found/.test(extract) && /availableTools/.test(route));
check('the original document is optional and kept out of synchronisation',
  /grn_document_files/.test(route) && /'grn_document_files'/.test(eligibility));
check('a document linked to a purchase cannot be discarded', /audit trail; it cannot be discarded/.test(route));
check('the route declares its database access', /'\/api\/grn':/.test(access));

// ---- v2.10.1: the wizard inside the Add Purchase modal -----------------------------------------
check('the import is offered inside the Add Purchase modal, not only as a separate page',
  /data-testid="open-grn-import"/.test(shell) && /Import from GRN \/ PDF/.test(shell) && /GrnImportWizard/.test(shell));
check('the wizard is a dialog in the same style as the Add Purchase modal',
  /role="dialog"/.test(wizard) && /aria-modal="true"/.test(wizard) && /max-w-6xl/.test(wizard) && /rounded-t-3xl/.test(wizard));
check('the wizard hands values back and never posts a purchase itself',
  /onApply/.test(wizard) && !/\/api\/purchases/.test(wizard) && /Use in Purchase Form/.test(wizard));
check('only accepted fields are returned, and a field already typed is not ticked by default',
  /tick\[k\] = filled && !typed/.test(wizard) && /function pick\(/.test(wizard));
check('Escape, Cancel and a backdrop click close the wizard', /key === 'Escape'/.test(wizard) && /Cancel/.test(wizard) && /e.target === e.currentTarget/.test(wizard));
check('the whole document is reported, including pages that were not recognised',
  /unrecognised_pages/.test(wizard) && /page_count/.test(wizard) && /one GRN, one party bill and the first goods line/.test(wizard));
check('each field cites the page it came from', /sourceOf/.test(wizard) && /grn_page/.test(wizard) && /bill_page/.test(wizard));
check('the response is normalised at the boundary, with a safe default draft',
  /normaliseGrnResponse/.test(wizard) && /emptyDraft/.test(contract) && /problems/.test(contract));
check('the crash path is gone: no unguarded result.draft.calculation anywhere',
  !/result\.draft\.calculation/.test(fs.readFileSync('app/grn/page.tsx', 'utf8')) && !/result\?\.draft\.calculation/.test(fs.readFileSync('app/grn/page.tsx', 'utf8')));
check('a password-protected PDF is named rather than reported as empty', /ENCRYPTED_PDF/.test(route));

// ---- v2.10.2: reading the document with nothing installed --------------------------------------
const native = fs.readFileSync('lib/grn/pdf-native.ts', 'utf8');

check('the PDF is read in plain JavaScript, with no external tool and no new dependency',
  /from 'node:zlib'/.test(native) && !/child_process|execFile|spawn/.test(native)
  && !/require\(|from '(?!node:)/.test(native.replace(/^\s*\*.*$/gm, '')));
check('the built-in reader is the primary path, and poppler/tesseract are optional accelerators',
  /readPdf\(bytes/.test(extract) && /optional accelerators/.test(extract));
check('the page count is the document\'s real one, never the scan limit',
  /const pageCount = doc.pageCount/.test(extract) && !/needsOcr\.push\(\.\.\.Array\.from/.test(extract));
check('a text-layer PDF is read with no tool at all', /textFromContent/.test(native) && /\bTj\b/.test(native));
check('a scanned page is produced as an image from the file itself, so the pages can always be read',
  /DCTDecode/.test(native) && /samplesToPng/.test(native) && /nativePageImage/.test(extract));
check('recognition reads the page\'s own embedded image, so poppler is not required',
  /The page's own embedded image is the scanner's original and needs nothing installed/.test(extract)
  && /recognisePage\(image.bytes, \{/.test(extract));
check('an installed tool that is not on the PATH is still found', /extraSearchDirs/.test(extract) && /Tesseract-OCR/.test(extract) && /Library\\\\bin/.test(extract));
check('a document that could not be read is offered for manual entry instead of refused',
  /manual_entry: manualEntry/.test(route) && /manual_entry: boolean/.test(contract) && /grn-manual/.test(wizard));
check('a document that must be read by eye keeps its pages so they can be shown',
  /manualEntry && extraction.viewable_pages.length > 0/.test(route));
check('nothing is proposed in manual entry: no field is ticked until it is typed',
  /tick\[k\] = filled && !typed && !normalised.manual_entry/.test(wizard) && /Typing a value is itself the decision/.test(wizard));
check('a PDF with no pages at all is still refused with its own reason',
  /no pages were found in it/.test(route));
check('the manual-entry path still posts nothing',
  !/INSERT\s+INTO\s+(purchases|payments|ledger)/i.test(route) && !/\/api\/purchases/.test(wizard));

// ---- v2.11.0: the OCR engine that ships with SOLIVY --------------------------------------------
const ocr = fs.readFileSync('lib/grn/ocr-wasm.ts', 'utf8');
const vendor = 'vendor/tesseract-wasm';

check('an OCR engine ships with the application, so a scan needs nothing installed',
  ['tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm.js', 'tessdata/eng.traineddata'].every((f) => fs.existsSync(`${vendor}/${f}`)));
check('its provenance, checksums and licence notices ship with it',
  fs.existsSync(`${vendor}/NOTICE.md`) && /Apache License 2\.0/.test(fs.readFileSync(`${vendor}/NOTICE.md`, 'utf8'))
  && ['LICENSE-tesseract.txt', 'LICENSE-tessdata.txt', 'LICENSE-leptonica.txt', 'LICENSE-libjpeg.txt', 'LICENSE-libpng.txt', 'LICENSE-zlib.txt'].every((f) => fs.existsSync(`${vendor}/licenses/${f}`)));
check('the engine is local: no network call, no upload, no cloud service',
  !/https?:\/\//.test(ocr.replace(/^\s*\*.*$/gm, '')) && !/fetch\(|XMLHttpRequest|axios/.test(ocr) && /Nothing leaves the machine/.test(ocr));
check('its files are found from the module\'s own location, not the working directory or the PATH',
  /__dirname/.test(ocr) && /last resort only/.test(ocr) && /SOLIVY_GRN_OCR_WASM_DIR/.test(ocr));
check('the bundled engine is the default, and the environment overrides are optional',
  /process.env.SOLIVY_GRN_OCR_ENGINE \|\| 'bundled'/.test(extract));
check('page images go straight to OCR, so an ordinary scan needs no poppler',
  /recognisePage\(image.bytes/.test(extract) && /embedded image is the scanner's original/.test(extract));
check('the engine is created once and reused, and each page is cleared after it',
  /if \(loaded && loaded.lang === lang && loaded.dir === info.dir\) return loaded/.test(ocr) && /api.Clear\(\)/.test(ocr) && /FS.unlink\('\/input'\)/.test(ocr));
check('a missing engine, missing language data or an unreadable page is reported, never a false success',
  /Reinstall SOLIVY/.test(ocr) && /Language data for/.test(ocr) && /could not be decoded/.test(ocr)
  && /status: 'failed'/.test(extract) && /status: 'not-attempted'/.test(extract));
check('recognition has a time budget rather than running without limit', /ocrBudgetMs/.test(extract));
check('every page records which engine read it, how long it took and how sure it was',
  /PageDiagnostic/.test(extract) && /confidence: number \| null/.test(extract) && /data-testid="grn-diagnostics"/.test(wizard));
check('a unit accepted through a known recognition misreading is flagged, not corrected silently',
  /UNIT_OCR_VARIANTS/.test(parse) && /unitToKgDetailed/.test(parse) && /code: 'UNIT_CORRECTED', severity: 'review'/.test(draft));
check('the received weight is never written into the dispatched-weight field',
  /billWeight \?\? \(bill \? null : grnWeight\)/.test(draft) && /DISPATCHED_WEIGHT_UNKNOWN/.test(draft));
check('the review screen separates what was recognised from what the user typed',
  /data-edited=/.test(wizard) && /data-confidence=/.test(wizard));
check('OCR adds no API call: recognition happens inside the existing upload request',
  (wizard.match(/fetch\(/g) || []).length === 1 && /POST/.test(wizard) && !/\/api\/ocr/.test(wizard + route));

// ---- v2.11.0: the OCR engine ships with SOLIVY ------------------------------------------------
const ocrWasm = fs.readFileSync('lib/grn/ocr-wasm.ts', 'utf8');
const notice = fs.readFileSync('vendor/tesseract-wasm/NOTICE.md', 'utf8');
const vendorFiles = fs.readdirSync('vendor/tesseract-wasm');

check('the OCR engine is bundled with the application, not expected on the machine',
  vendorFiles.includes('tesseract-core-lstm.wasm') && vendorFiles.includes('tesseract-core-lstm.wasm.js')
  && fs.existsSync('vendor/tesseract-wasm/tessdata/eng.traineddata'));
check('the bundled engine is the default, with the installed Tesseract only as an alternative',
  /kind: 'bundled-wasm'/.test(extract) && /SOLIVY_GRN_OCR_ENGINE/.test(extract));
check('the engine is found from the module\'s own location, never the working directory or PATH',
  /const here = __dirname/.test(ocrWasm) && /last resort only/.test(ocrWasm) && !/process\.env\.PATH/.test(ocrWasm));
check('recognition is local: the engine makes no network call and sends no document anywhere',
  !/https?:\/\/|fetch\(|XMLHttpRequest|net\.|http\.request/.test(ocrWasm.replace(/^\s*\*.*$/gm, '').replace(/<https?:[^>]*>/g, ''))
  && /Nothing leaves the machine/.test(ocrWasm));
check('the redistribution licences and provenance of the bundled engine are recorded',
  /Apache License 2.0/.test(notice) && /tessdata_fast/.test(notice) && /SHA-256/.test(notice)
  && ['LICENSE-tesseract.txt', 'LICENSE-leptonica.txt', 'LICENSE-tessdata.txt'].every((f) => fs.existsSync('vendor/tesseract-wasm/licenses/' + f)));
check('language data is loaded from the bundled folder, and a missing language is named with its fix',
  /tessdata/.test(ocrWasm) && /Language data for/.test(ocrWasm) && /SOLIVY_GRN_OCR_LANG/.test(ocrWasm));
check('recognition is bounded in time and a page it does not reach is marked, not assumed read',
  /ocrBudgetMs/.test(extract) && /status: 'not-attempted'/.test(extract));
check('a page that produced no characters is recorded as a failure, not an empty success',
  /Recognition returned no characters for this page/.test(extract) && /status: 'failed'/.test(extract));
check('every page carries its own status, engine, duration, character count and confidence',
  /PageDiagnostic/.test(extract) && /confidence/.test(extract) && /diagnostics: PageDiagnostic\[\]/.test(extract));
check('the engine and per-page diagnostics reach the screen',
  /grn-diagnostics/.test(wizard) && /extraction.engine/.test(wizard) && /diagnostics/.test(route));
check('a page is recognised only when the parser finds its fields, not because OCR returned text',
  /parseDocument/.test(route) && /recognised: \{ grn: Boolean\(parsed.grn\)/.test(route));
check('the manual-entry path is kept for the case where no engine can be used at all',
  /manual_entry: manualEntry/.test(route) && /grn-manual/.test(wizard));
check('an OCR note is only shown when a page actually needed recognition',
  /if \(chosen.reason && needsOcr.length\)/.test(extract));

// ---- v2.11.1: the second OCR pass, gated and guarded -------------------------------------------
const regions = fs.readFileSync('lib/grn/regions.ts', 'utf8');

check('regions are located from the words on the page, not from pixel coordinates fixed for one PDF',
  /findPhrase/.test(regions) && /anchorOf/.test(regions) && !/\b(2558|3777|2669|3720)\b/.test(regions));
check('the second pass runs only when the first pass left a required field unread',
  /coverageOf\(pageText, PARSERS\)/.test(extract) && /covered every required field/.test(extract));
check('the second pass is kept only when it covers more than the first pass did',
  /after.score > before.score/.test(extract) && /the first pass was kept/.test(extract));
check('coverage is judged by the real parser, not by a separate rule',
  /const PARSERS = \{ grn: parseGrnPage, bill: parseBillPage \}/.test(extract));
check('a rebuilt table row is discarded unless every cell fits the shape of its column',
  /cellFitsColumn/.test(regions) && /GRN_CELL_SHAPE/.test(regions) && /return \[\];/.test(regions));
check('the extra passes per page are capped, so a page cannot become a retry loop',
  /MAX_REGIONS/.test(ocrWasm) && /slice\(0, MAX_REGIONS\)/.test(ocrWasm));
check('a region is read on the image already loaded — no crop, no copy, no second decode',
  /SetRectangle/.test(ocrWasm) && /already loaded/.test(ocrWasm));
check('the engine is put back on the whole page, so one page cannot be read through another\'s box',
  /Put the engine back on the whole page/.test(ocrWasm));
check('a wrapped supplier name is reassembled and reported as reassembled, not as read',
  /supplierJoined/.test(parse) && /printed wrapped inside its column/.test(parse));
check('every pass records where it came from, and the regions reach the diagnostics',
  /\[\[region /.test(regions) && /second_pass_reason/.test(extract) && /regions\?:/.test(extract));

// ---- v2.11.2: the engine must load under any module system -------------------------------------
check('the engine file is loaded by several guarded routes, not one that a bundler can remove',
  /loadFactory/.test(ocrWasm) && /typeof createRequire === 'function'/.test(ocrWasm)
  && /await import\('node:' \+ 'module'\)/.test(ocrWasm) && /eval\('typeof require/.test(ocrWasm)
  && /await import\(\/\* webpackIgnore: true \*\/ url\)/.test(ocrWasm));
check('a load failure names every route that was tried, never a bare type error',
  /could not be loaded by this build of SOLIVY/.test(ocrWasm) && /attempts.join\(' \| '\)/.test(ocrWasm)
  && /module-loading problem, not a missing engine/.test(ocrWasm));
check('the engine\'s own methods are checked before they are called',
  /does not provide \$\{what\}/.test(ocrWasm) && /the TessBaseAPI interface/.test(ocrWasm) && /the Recognize method|'Recognize'/.test(ocrWasm));
check('a module that loads but exports the wrong shape is reported, not invoked',
  /did not export a function/.test(ocrWasm));
check('a cached engine is reused only while it is still the one the settings point at',
  /loaded.dir === info.dir/.test(ocrWasm));
check('the self-test reports what is on disk now, not an engine loaded earlier in the process',
  /engineSelfTest/.test(ocrWasm) && /if \(!info.available\)/.test(ocrWasm));
check('the engine can be checked from the application without uploading a document',
  /selftest/.test(route) && /engineSelfTest/.test(route) && /load_attempts/.test(route));
check('a page failing because the engine never loaded is reported once, with the real reason',
  /engineLoadReported/.test(extract) && /Recognition could not run/.test(extract));
check('the load route and the failed attempts reach the diagnostics panel',
  /load_route/.test(extract) && /grn-load-attempts/.test(wizard) && /load_attempts: string\[\]/.test(contract));
check('a bill with no seller read does not invent a party name in its warning',
  /No seller was read from the document/.test(draft));

// ---- v2.12.0: a list is many GRNs, a document is many pages ------------------------------------
const multi = fs.readFileSync('lib/grn/multi.ts', 'utf8');

check('every data row of a consignment list is its own GRN, and the total row is not one',
  /export function parseGrnRows/.test(multi) && /isTotalRow/.test(multi) && /rowIndexes.forEach/.test(multi)
  && !/\.find\(isDataRow\)/.test(multi));
check('each row carries a stable identity from its page and printed position, not an array index',
  /id: `p\$\{page\}r\$\{n \+ 1\}`/.test(multi));
check('the response carries arrays, and one draft per row rather than a single GRN',
  /grns: set.grns.map/.test(route) && /rowDrafts/.test(route) && /grns: NormalisedGrnRow\[\]/.test(contract));
check('every page is classified and kept, including one nothing could be made of',
  /export function classifyPage/.test(multi) && /'receipt'/.test(multi) && /'unknown'/.test(multi)
  && /unrecognised_pages/.test(multi));
check('the printed total is a cross-check that never corrects a row',
  /export function listTotals/.test(multi) && /differences/.test(multi) && !/printed\[c\] = summed/.test(multi));
check('a row with more figures than columns leaves the money empty instead of placing it',
  /ROW_EXTRA_FIGURES/.test(multi) && /could not be placed with confidence and are left empty/.test(multi));
check('a goods line is read from the column order the bill itself prints',
  /function goodsColumns/.test(multi) && /COLUMN_WORDS/.test(multi));
check('a rate is never derived from the amount and passed off as the bill\'s rate',
  /calculated_check/.test(multi) && /cross-check only and has not been used as the rate/.test(multi)
  && /RATE_NOT_READ/.test(multi) && /RATE_COLUMN_ABSENT/.test(multi));
check('quantity times rate is checked against the amount, and a disagreement is reported not fixed',
  /LINE_DOES_NOT_MULTIPLY/.test(multi) && /Nothing was changed/.test(multi));
check('figures are not placed in neighbouring columns to make a line fit',
  /LINE_COLUMN_COUNT/.test(multi) && /without risking a figure in the wrong column/.test(multi));
check('a bill is linked to a row only on corroborating evidence, with ties reported',
  /export function matchDocuments/.test(multi) && /alternatives/.test(multi) && /fit this bill about as well/.test(multi));
check('dispatched and received weights stay separate when a row becomes a draft',
  /export function asParsedDocument/.test(multi) && /quantity_kg/.test(multi) && /deduction_per_kg: f<number>\(null/.test(multi));
check('one row is reviewed and taken at a time; a list is never combined into one purchase',
  /grn-rows/.test(wizard) && /chooseRow/.test(wizard) && /a list is never combined into one/.test(wizard));
check('the multi-row path still posts nothing from the wizard',
  !/\/api\/purchases/.test(wizard) && !/INSERT\s+INTO\s+purchases/i.test(route));

if (failed) { console.error(`${failed} GRN check(s) failed`); process.exit(1); }
console.log('GRN pipeline checks passed');
