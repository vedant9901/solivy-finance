# SOLIVY Finance v2.11.0 — scanned GRN pages are read automatically

Baseline: v2.10.2. No schema change, no new API route, no new network call, no sync change.

## 1. What this release removes

v2.10.2 could read a text-layer PDF with nothing installed, and could show a scan's pages — but
recognising a scan still needed Tesseract on the machine. On a normal Windows installation it was
not there, so the GRN had to be typed in by eye. That requirement is gone.

**The OCR engine now ships inside SOLIVY.** `vendor/tesseract-wasm/` carries a WebAssembly build of
Tesseract (2.8 MB) and the English language data (4.1 MB). It runs inside SOLIVY's own Node process:

- nothing to install — no `.exe`, no installer, no architecture to match;
- no `PATH` entry and no environment variable;
- no internet — the engine is local, and recognition works with the network disconnected;
- nothing leaves the machine — no cloud OCR, no telemetry, no upload of the PDF, the page images or
  the recognised text. There is no OCR endpoint and no per-page request: recognition costs **zero**
  API calls and zero Neon transfer.

Measured on the supplied two-page scan, with no Tesseract and no Poppler installed and `PATH`
emptied: **page 1 recognised in 4.9 s at confidence 89, page 2 in 6.9 s at confidence 70**, and the
parser then found every printed field (section 4).

## 2. How it works

- **`lib/grn/ocr-wasm.ts`** loads the engine by a path resolved from **its own module location**
  (`__dirname` → `<app>/vendor/tesseract-wasm`, with a few parent levels tried for a bundled server
  build, and the working directory only as a last resort). Never the working directory as the
  primary source, never `PATH`. The language data is written into the engine's in-memory filesystem,
  so `TESSDATA_PREFIX` and the install location are irrelevant. The engine is created once per
  process and reused — `Init` costs about a second, a page a few seconds.
- **`lib/grn/extract.ts`** chooses the engine (`bundled-wasm` by default; `SOLIVY_GRN_OCR_ENGINE` can
  ask for the installed Tesseract instead, and falls back to the bundled one with the reason stated),
  and hands each page the image **already embedded in the PDF** — so Poppler is not involved for an
  ordinary scan. The image's resolution is computed from the page's MediaBox and passed to the
  engine, rather than letting it guess. Poppler is used only for a vector-only page that carries no
  image at all.
- Acquiring the text and parsing the business fields stay separate. **A page is not "recognised"
  because OCR returned characters**: `lib/grn/parse.ts` has to find GRN or supplier-bill fields, and
  `recognised.grn` / `recognised.bill` in the response come from the parser, not from the engine.

### Limits and cleanup

15 MB per upload, 25 pages read, a 180-second recognition budget
(`SOLIVY_GRN_OCR_BUDGET_MS`) after which the remaining pages are marked **not attempted** rather
than assumed read. Temporary files go to a `mkdtemp` directory removed in a `finally`; the engine's
page is cleared after every page so one page's result cannot leak into the next.

### Failure handling

Each case has its own message and none of them reports a false success: engine files missing
(names the folder and the override), language data missing (names the folder, what is in it and the
fix), engine will not initialise, page with no image, recognition returning no characters (status
`failed`, "may be blank, upside down or too faint"), budget exhausted (`not-attempted`), and the
existing refusals — not a PDF (415), empty (400), over 15 MB (413), password-protected (422
`ENCRYPTED_PDF`), no pages at all (422).

### Diagnostics

"Show how this document was read" in the wizard, from the same data the endpoint returns: engine
kind, Tesseract version, engine path, tessdata path, languages present, language requested, PSM, the
document's page count and total time, and per page — status, which engine, duration, character count
and confidence. Local only; nothing is synced and the recognised text is not logged.

## 3. What did not change

The wizard stays inside the existing Add Purchase modal. Upload → automatic per-page recognition →
page previews beside the extracted fields, each with its confidence and source page → your review →
you explicitly accept, and the values go back to the Add Purchase form. **Add Purchase → Save remains
the only accounting write path**: the wizard creates no party, purchase, payment, stock movement or
ledger entry, and cancelling or closing it leaves no accounting record. Uncertain and missing values
are shown for review and are never silently corrected. `lib/utils.ts purchaseCalc` remains the only
calculation, so an accepted draft totals identically online and offline.

Also unchanged: `grn_documents` holds the audit record and synchronises; `grn_document_files` holds
the optional original, is local-only and is excluded from synchronisation. No new table was added for
this release, and no sync payload, snapshot format, conflict rule or Neon schema was touched.

## 4. The real sample, recognised by the bundled engine

`tests/integration/grn-ocr-bundled.test.ts` runs the supplied `VRHUF-DEEPAKTRA-17.10.pdf` with the
installed tools taken away, and asserts the parser's output field by field. All of the following is
**PASS**, from the bundled WebAssembly engine:

| | Expected | Read |
|---|---|---|
| Sample no | 2627-22603 | ✔ |
| GRN date | 17.10.2026 | 2026-10-17 ✔ |
| Truck suffix | 5630 | ✔ |
| Bags | 375 | ✔ |
| **Received** net weight | 21 262 kg | ✔ |
| Moisture | 11.50 % | ✔ (threshold 14 %, read from the page) |
| Supplier | Deepak Enterprises | ✔ |
| Invoice / date | 274 / 13-Oct-26 | 274 / 2026-10-13 ✔ |
| Vehicle | GJ04X5630 | ✔ |
| Packages | 375 | ✔ |
| Product / HSN | Maize / 10059000 | ✔ |
| **Dispatched** quantity | 218.90 qtl = 21 890 kg | ✔, kept separate from the received weight |
| Rate | ₹2,000/qtl = ₹20/kg | ✔ |
| Amount | ₹4,37,800 | ✔ |

- **The two weights stay distinct.** The received 21 262 kg is the purchase's net weight; the
  dispatched 21 890 kg is carried as the gross weight. Neither overwrites the other, and when the
  dispatched unit cannot be read the gross weight is left empty with a warning rather than filled in
  from the received figure.
- **No deduction is invented.** The GRN prints that deductions apply above 14 % moisture and this
  consignment is 11.50 %, so the moisture deduction is 0 and the reading is reported as information
  (`MOISTURE_REPORTED`). The rate conversion is reported too (`RATE_CONVERTED`).
- **The pages are linked on corroborating evidence** — the vehicle number (the GRN's truck suffix
  against the bill's full number), the package count and the dates — and the reasons are shown. A
  contradiction counts against the link and is flagged rather than hidden.

## 5. Verification

Evidence: `docs/verification/test-run-2026-11-02-v2.11.0.txt`.

| Test | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | **PASS** — 0 errors |
| Offline suite (SQLite, sample set) | **PASS** — 141/141 |
| Online suite (real PostgreSQL 16.15) | **PASS** — 56/56 |
| Browser suite (Playwright Chromium) | **PASS** — 20/20 |
| Source invariants (`scripts/check-*`) | **PASS** — 24/24 run; `check-grn.cjs` is 66 invariants |
| Bundled OCR with nothing installed | **PASS** — 12/12 in `grn-ocr-bundled.test.ts` |
| Real sample, both pages, every field | **PASS** — section 4 |
| Text-layer PDF, page counts, per-page status | **PASS** |
| Failure handling (engine, language, timeout, no-text page, corrupt, encrypted, oversized) | **PASS** |
| Parser, linking, qtl→kg, separate weights, `purchaseCalc` | **PASS** |
| No accounting record before Save | **PASS** — asserted at the API and in the browser |
| Offline operation | **PASS** — the engine makes no network call; asserted by a test that fails if `fetch`/`http` is reached during a read |
| Linux development | **PASS** — this environment |
| **Windows development** | **NOT VERIFIED** — no Windows machine here. Commands in section 6 |
| **Packaged Windows build** | **NOT VERIFIED** — and this project has no Windows installer or packaging configuration to extend (no `.bat`, `.ps1`, electron-builder, NSIS or MSI config exists in the repository; `LOCAL-INSTALL-GUIDE.md` describes a manual Node install). Section 6 |
| `next build` | **NOT VERIFIED** — the npm registry is unreachable from this environment, so Next.js 15.5.27 is not installed. Routes and components are exercised through a `next/server` shim and real esbuild + Chromium bundles |
| GRN against Neon | **NOT VERIFIED** — the online suite runs on a local PostgreSQL 16 and includes no GRN upload |
| API/Neon before-and-after byte measurement | **NOT VERIFIED as a measurement** — but asserted structurally: recognition adds no endpoint and makes no request, so the Add Purchase + OCR + Save flow issues the same requests as before plus the one existing `POST /api/grn`. No instrumented byte comparison was run |

## 6. Windows verification — exact steps

This environment is Linux, so nothing below was run; do not read section 5 as Windows evidence. The
engine is WebAssembly and platform-independent, which is why no Windows-specific build exists — but
that is an argument, not a test.

Confirm Tesseract is genuinely absent, then run the suite:

```powershell
# 1. No Tesseract anywhere
Get-Command tesseract -ErrorAction SilentlyContinue        # expect: no output
$env:PATH -split ';' | Select-String -Pattern 'Tesseract'  # expect: no output
Test-Path 'C:\Program Files\Tesseract-OCR\tesseract.exe'   # expect: False

# 2. The bundled engine is where SOLIVY expects it
cd <solivy folder>
Get-ChildItem vendor\tesseract-wasm, vendor\tesseract-wasm\tessdata |
  Select-Object Name, Length
# expect: tesseract-core-lstm.wasm 2855361, tesseract-core-lstm.wasm.js 3896484,
#         eng.traineddata 4113088
Get-FileHash vendor\tesseract-wasm\tesseract-core-lstm.wasm -Algorithm SHA256
# expect: 66B17DF6E20C5329A17FFA9C202A47EAA3E32500B253D4C7F38E7F2BC01457C3

# 3. Recognise the real sample with the network off
$env:SOLIVY_GRN_SAMPLE_PDF = 'C:\path\to\VRHUF-DEEPAKTRA-17.10.pdf'
Disable-NetAdapter -Name '*' -Confirm:$false                # or pull the cable
node --require .\tests\setup\register.cjs --import tsx --test `
  --test-concurrency=1 tests\integration\grn-ocr-bundled.test.ts
# expect: # pass 12   # fail 0
Enable-NetAdapter -Name '*' -Confirm:$false
```

Then in the application: start SOLIVY, open **Add Purchase → Import from GRN / PDF**, upload the
scan, and check that both pages come back recognised with the fields of section 4 filled in, that
"Show how this document was read" names *the OCR engine built into SOLIVY* with a Tesseract version
and `eng` language data, and that no purchase exists until you press Save.

**Packaging:** there is no Windows installer in this repository to put the engine into. Whatever
packaging you add must copy `vendor/tesseract-wasm/` (all three files and `licenses/`) next to the
application and keep `NOTICE.md` with it — the Apache-2.0 components require that notice to
accompany the distribution. If the packager bundles the server into a single file, set
`SOLIVY_GRN_OCR_WASM_DIR` to the folder where those files land, or keep them at
`<install>/vendor/tesseract-wasm`, which is found automatically.

## 7. Licences

Full notices, provenance commits and SHA-256 checksums: `vendor/tesseract-wasm/NOTICE.md`, with each
component's licence text in `vendor/tesseract-wasm/licenses/`.

- **tesseract.js-core 7.0.0** (the WebAssembly build of Tesseract, reporting Tesseract
  `5.1.0-288-g2a9c1`) — Apache-2.0, copied unmodified from that project's committed build artefacts.
- **`eng.traineddata`** from **tessdata_fast** — Apache-2.0, copied unmodified.
- Statically linked: Tesseract (Apache-2.0), Leptonica (BSD-2-Clause), libjpeg (IJG), libpng (PNG
  v2), zlib, libtiff, libwebp (BSD-3-Clause), giflib (MIT), openlibm (MIT).

All permit binary redistribution with the notice and licence text, which is what that folder carries;
none is copyleft in a way that affects SOLIVY's own source.

## 8. What is still true

1. Recognition is **Tesseract-quality on scans** — good, not perfect. Every value is shown with its
   confidence and source page for checking, and low-confidence readings are flagged rather than
   corrected. The sample's buyer GSTIN, for instance, is misread by the scanner and is reported as
   low confidence with a check-digit note instead of being "fixed".
2. **One GRN, one party bill, the first goods line**, and the parser is written for those two
   layouts. Anything else is reported as unrecognised, never mapped wrongly.
3. Only English language data ships. Add another `*.traineddata` to `vendor/tesseract-wasm/tessdata/`
   and set `SOLIVY_GRN_OCR_LANG` (e.g. `eng+hin`).
4. Recognition is CPU-bound and single-threaded here: about 5–7 seconds a page on this machine. A
   25-page document will reach the 180-second budget; raise `SOLIVY_GRN_OCR_BUDGET_MS` if you need
   more.
5. Windows packaging, `next build` and Neon remain unverified (sections 5 and 6).
