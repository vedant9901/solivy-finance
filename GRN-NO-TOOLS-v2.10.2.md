# SOLIVY Finance v2.10.2 — the GRN import works with nothing installed

Baseline: v2.10.1. No schema change, no new dependency, no new network call.

## 1. What was reported, and what was actually wrong

On the reporting machine the wizard answered:

```
No text could be read from this PDF on this machine. The response carried no draft purchase.
document · 0 pages · read by nothing · no GRN page recognised · no party bill recognised
· pdftotext was not found …
· 20 page(s) carry no text layer and must be recognised, but pdftoppm and tesseract were not found …
```

Three separate defects, not one:

1. **Every step was delegated to an external tool.** The page count, the text layer and the page
   images all came from poppler, and recognition from tesseract. With neither installed the feature
   could do nothing at all — not even show the pages — so "install these three binaries" was the
   whole of what SOLIVY could offer.
2. **"20 page(s)" was a fabricated figure.** With no text-layer tool the extractor had no page
   count, so it listed its own scan limit (`maxPages`, default 20) as pages needing recognition. The
   document has two. A financial screen must never print a number it does not have.
3. **A document that could not be read was a dead end.** The endpoint answered 422 with no draft, so
   the review screen had nothing to show and nothing to type into, even though the pages were
   perfectly readable by eye.

## 2. What changed

**`lib/grn/pdf-native.ts` (new) — the PDF is read in plain JavaScript.** Node's own `zlib` is the
only thing it uses; it runs nothing and reaches nothing. It walks the object table and the page tree
(including objects packed into `/ObjStm`) and produces:

- the document's **real page count**;
- **per-page text** decoded from the content streams (`Tj`, `TJ`, `'`, `"`, with PDF string escapes
  and hex strings), so a digitally produced GRN or Tally bill is read exactly, anywhere;
- **per-page images**: a `/DCTDecode` page *is* a JPEG and is handed over as it stands, and an
  8-bit `/FlateDecode` DeviceRGB/DeviceGray page is re-wrapped as a PNG (CRC32 and deflate written
  by hand). The supplied scan is one JPEG per page, so both its pages come out at full scanner
  resolution — 2558×3777 and 2669×3720.

**`lib/grn/extract.ts` — the built-in reader is now the primary path.** The external tools became
optional accelerators:

| | v2.10.1 | v2.10.2 |
|---|---|---|
| Page count | poppler, else the scan limit | the page tree, always |
| Text-layer PDF | needs `pdftotext` | read with nothing installed; `pdftotext -layout` preferred where present, for its column spacing |
| Page image | needs `pdftoppm` | taken from the file; `pdftoppm` only for a vector-only page |
| Recognising a scan | needs `pdftoppm` **and** `tesseract` | `tesseract` alone — it is given the page's own embedded image |
| Nothing installed | nothing worked | pages shown, values typed in, totals calculated |

Recognition is still fed a known scale: the rendered path keeps the measured 300 dpi, and the
embedded-image path works the resolution out from the image width against the MediaBox and passes
it as `--dpi`, rather than letting the engine guess. Verified: with poppler absent, the sample's
every field comes through identically to the poppler path.

**Tool discovery was broadened.** On Windows, poppler and tesseract are routinely installed without
their folder being added to the PATH — the commonest reason the earlier build called them missing on
a machine that had them. `Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%\Programs`,
`ProgramData`, chocolatey, scoop and any unzipped `poppler*` / `Release-*` folder (keeping its
`Library\bin` layout) are now searched as well, and `SOLIVY_PDFTOTEXT` / `SOLIVY_PDFTOPPM` /
`SOLIVY_TESSERACT` still override everything.

**A document that cannot be read is now a manual entry, not a refusal.** The endpoint stores the
document, keeps a local copy so its pages can be served, and answers 200 with `manual_entry: true`
and a **complete but entirely empty** draft. The wizard then:

- states plainly that the pages are scans, that nothing could be read and that **nothing has been
  guessed**;
- shows the pages beside the fields, at full scanner resolution, with the page selector;
- lists **every** field to type into (not only the ones that carried a value);
- ticks nothing by default, and ticks a field as it is typed — so only what you entered is carried
  back;
- keeps the live total through `purchaseCalc`, by the same rules the purchase form uses.

A PDF with no pages at all is still refused, with that as its reason. The kept copy stays on the
machine: `grn_document_files` is local-only and excluded from synchronisation, and discarding the
entry deletes it. The wizard still posts nothing — Add Purchase → Save remains the only write path.

## 3. Verification — what was run

Evidence: `docs/verification/test-run-2026-11-01-v2.10.2.txt`.

| | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.verify.json` | **PASS** — 0 errors |
| `npm test` (offline, SQLite, sample set) | **PASS** — 129/129 |
| `npm run test:online` (PostgreSQL 16.15) | **PASS** — 56/56 |
| `npm run test:ui` (Playwright Chromium) | **PASS** — 17/17 |
| `scripts/check-*` | **PASS** — 24/24 run; `check-grn.cjs` is 32 invariants, 12 new here |
| `next build` | **NOT VERIFIED** — the npm registry is unreachable in this environment, so Next.js 15.5.27 is not installed. Routes and components are exercised through a `next/server` shim and real esbuild + Chromium bundles |
| GRN against Neon | **NOT VERIFIED** — the online suite runs on a local PostgreSQL 16 and includes no GRN upload |

New regression tests: `tests/integration/grn-native.test.ts` — 13 tests, every one with all three
tools **forced absent** (the overrides point at a path that does not exist and PATH is emptied), so
what passes there is what the reporting machine gets. They cover the real page count, text-layer
reading with no tools, the JPEG and the PNG page-image paths, the "2 of 2 pages" wording, the
manual-entry response, the served page image, the damaged-PDF refusal, the normaliser's defaults,
and that nothing is posted. Plus one browser test: typing into the manual-entry table ticks the
field, moves the total to ₹4,25,240 and hands back only what was typed.

Two stale invariant markers were corrected in the same pass: `check-sync.mjs` looked for the device
token header in the exchange route after it had moved into `lib/sync-auth.ts` (the check now follows
it there, and still requires `syncTokenContext` and `preAuthorize` in the route), and
`check-grn.cjs` tracked a comment that this release rewrote. `check-env.mjs` reads an installed
machine's `.env.local` and is not applicable here.

## 4. What is still true

1. **Recognising a scan still needs Tesseract.** No OCR engine can be added here — the npm registry
   is unreachable in this environment, and no OCR engine ships with the project. What changed is
   that its absence no longer stops the work: the pages are shown and the values are typed in, and
   when Tesseract *is* installed it now works on its own, with no poppler.
2. **One GRN, one party bill, the first goods line**, and the parser is written for those two
   layouts. Anything else is reported as unrecognised, never mapped wrongly.
3. The `/ObjStm` path is implemented but not covered by a test — no producer available here emits
   object streams. A document using them falls back to the plain object scan.
4. `next build` and Neon remain unverified in this environment.

## 5. If you want automatic recognition on Windows

Install **Tesseract OCR** (the UB Mannheim installer, default
`C:\Program Files\Tesseract-OCR`, keep the English language data) and restart SOLIVY. Nothing else
is needed — not poppler, and no PATH change, since that folder is now searched. Poppler is worth
adding only for PDFs whose pages are vector drawings rather than scans.

If you prefer to point SOLIVY at the files directly, set them alongside the other SOLIVY settings:

```
SOLIVY_TESSERACT=C:\Program Files\Tesseract-OCR\tesseract.exe
SOLIVY_PDFTOTEXT=C:\Program Files\poppler\Library\bin\pdftotext.exe
SOLIVY_PDFTOPPM=C:\Program Files\poppler\Library\bin\pdftoppm.exe
```

Tuning, unchanged: `SOLIVY_GRN_OCR_DPI` (300), `SOLIVY_GRN_OCR_PSM` (4), `SOLIVY_GRN_OCR_LANG`
(`eng`), `SOLIVY_GRN_TEXT_MIN` (12).
