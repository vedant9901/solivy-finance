# SOLIVY Finance v2.11.1 — a second, targeted OCR pass, and the wrapped supplier name

Baseline: v2.11.0. No schema change, no new API route, no new network call, no sync change.

## 1. The diagnosis in the brief did not reproduce

The brief reported that whole-page OCR "misses important small table cells including truck number,
received weight and moisture", and that only a 2× table crop reads the row.

**On the shipped v2.11.0 pipeline, with the bundled WebAssembly engine and nothing installed, the
whole-page pass already reads the whole row.** The file is byte-identical to the sample already in
use (SHA-256 `7a14c520…d663a0`), so this is the same document, not a different copy. The engine's
own page-1 text contains, verbatim:

```
2627-22603 | 17.10.2026 | 5630 ENTERPRIS 375 21262 0 0 0 11.50 0.00
```

and the parser turns that into sample `2627-22603`, date `2026-10-17`, truck `5630`, bags `375`,
received `21262` kg, freight `0`, load/unload `0`, rokdi `0`, moisture `11.5 %`, deduction `0`,
threshold `14 %`. The brief's measurement was taken with the *system* Tesseract on the extracted
JPEGs; this pipeline feeds the engine the embedded image with the resolution computed from the page
geometry, which is why the results differ. Evidence:
`docs/verification/test-run-2026-11-02-v2.11.1.txt`.

So the premise is not the defect. One real field defect was in that same row, and it is fixed; the
targeted second pass asked for is implemented, with the guards that make it safe.

## 2. The real defect: a name the document prints wrapped

`PO Supplier` is a narrow column, and `AKSH ENTERPRISE` does not fit it, so the mill's own report
prints it wrapped across three lines. OCR returns it the same way — `AKSH` above the row,
`ENTERPRIS` inside it, a lone `E` below — and v2.11.0 took only the fragment in the row:

| | v2.11.0 | v2.11.1 |
|---|---|---|
| `supplier_name` | `ENTERPRIS` | `AKSH ENTERPRISE` |

`lib/grn/parse.ts` now folds the neighbouring lines back into the cell: a short all-letters line
immediately above the row begins the name, and one to three letters immediately below continue the
word it was broken across. The field carries a note saying it was reassembled and what the row
itself read, so the reviewer can check it against the page — it is not presented as read verbatim.
Anything that does not match that shape is left alone.

## 3. The second pass — gated, additive, and guarded

**`lib/grn/regions.ts`** (new) locates the parts of a page worth reading again, and
**`recognisePage` in `lib/grn/ocr-wasm.ts`** reads them.

- **Located from the page's own words, never from pixel coordinates.** The first pass returns word
  boxes (the engine's TSV output). The anchors are the labels printed on the page — *Sample No*,
  *Truck No*, *GRN Date*, *Recd. Net*, *Moist*, *Party Code*; *Invoice No*, *HSN/SAC* on a bill —
  and the region is derived from where those words actually sit, bounded below by the *Total* line
  or the notes beneath the table. A page printed at another size or scanned at another resolution
  therefore yields the same region, scaled: a test doubles every coordinate and asserts the region
  doubles with it. A page without the anchors yields **no** region rather than a guessed one.
- **Read on the image already loaded**, with `SetRectangle` and a page-segmentation mode suited to
  a block. No crop, no image copy, no second decode: a region costs a recognition, not a page. At
  most 4 regions per page (`SOLIVY_GRN_OCR_MAX_REGIONS`), inside the existing 180-second budget,
  and the engine is put back on the whole page afterwards so one page cannot be read through
  another's box.
- **The gate: it runs only when the first pass left a required field unread.** Coverage is measured
  with the real parser — the same rules that build the draft — so there is one definition of "read"
  and not two. On the supplied sample the first pass covers all six required GRN fields and all
  seven bill fields, so **no region is read again**, and the diagnostics say exactly that.
- **The guard: a second pass is kept only if it covers more than the first did.** This matters,
  because measurement showed the band-level pass is *worse* than the whole page on this document —
  reading the table alone at PSM 6 lost cells the full page had read. Rather than ship a change
  that can degrade a page, the combined text is compared against the first pass by coverage and
  discarded unless it is strictly better. A region pass can add a missing cell; it can never spoil
  a page that was already right.
- **The row rebuild, and why it is checked.** The table region's word boxes are grouped into
  columns by the header's own positions, which is what joins a wrapped cell properly
  (`AKSH` + `ENTERPRIS` + `E` → `AKSH ENTERPRISE`) instead of guessing from the order of the text.
  On real scans, though, the boxes do not always line up with the header's, and a cell can land one
  column over. So every rebuilt cell is checked against the shape its column must hold — a date in
  the date column, digits in the weight column — and **if any cell does not fit, the whole rebuild
  is discarded**. A mislabelled weight is far worse than no rebuild. The region's raw text is still
  contributed, and the whole-page pass still stands.
- **Provenance.** Each pass's text is marked `[[region <name>]]`, so a value's origin is visible and
  the same row read twice still parses to one set of fields (asserted).

### Diagnostics added

Per page: the image dimensions handed to recognition, each region's name, rectangle, character
count, confidence and duration, and `second_pass_reason` — which says either that the first pass
covered everything, or which fields were missing, or that the regions added nothing and the first
pass was kept. No OCR text is logged.

## 4. Unchanged

The wizard stays inside the Add Purchase modal; the user reviews, corrects and explicitly accepts;
**Add Purchase → Save remains the only accounting write path** and no party, purchase, payment,
stock or ledger record exists before it. Recognition is local — no cloud OCR, no OCR endpoint, no
per-page request, zero API calls and zero Neon document transfer — and works offline. Dispatched
(21 890 kg) and received (21 262 kg) weights stay distinct; no moisture deduction is created at
11.50 % against the 14 % threshold the page prints; pages are linked on vehicle, package count and
date with the reasons shown; `purchaseCalc` remains the only calculation. No schema, sync payload,
snapshot format or conflict rule was touched.

## 5. Verification

Evidence: `docs/verification/test-run-2026-11-02-v2.11.1.txt`.

| Test | Result |
|---|---|
| Typecheck | **PASS** — 0 errors |
| Offline suite (SQLite, sample set) | **PASS** — 155/155 |
| Online suite (real PostgreSQL 16.15) | **PASS** — 56/56 |
| Browser suite (Playwright Chromium) | **PASS** — 20/20 |
| Source invariants | **PASS** — 24/24 run; `check-grn.cjs` now 76 invariants |
| The exact supplied PDF through the **bundled WASM engine** | **PASS** — both pages, every field of section 7 |
| Supplier name reassembled to `AKSH ENTERPRISE` | **PASS** |
| Region located from anchors, scales with the page, absent without anchors | **PASS** — 3 tests |
| Wrapped cell rebuilt by column | **PASS** |
| Mislabelled rebuild discarded | **PASS** — on synthetic geometry and on a real rendered scan |
| The engine's region pass end-to-end (`SetRectangle`, words, confidence) | **PASS** — on a rendered page |
| Gate: no second pass when the first pass is complete | **PASS** — asserted on the real sample |
| Guard: a worse second pass cannot raise coverage | **PASS** |
| Multi-pass text does not duplicate or re-assign a value | **PASS** |
| A second GRN layout (different mill, numbers, wrapped name) | **PASS** — region detection is not pinned to the sample |
| Text-layer PDF, page counts, per-page status | **PASS** |
| Failures: no engine, no language data, timeout, no-text page, corrupt, encrypted, oversized | **PASS** |
| Page linking, qtl→kg, separate weights, `purchaseCalc` | **PASS** |
| No accounting record before Save | **PASS** — API and browser |
| Offline / zero network during a read | **PASS** — a test fails if `fetch`/`http` is reached |
| **Assert full-page OCR alone is insufficient on this PDF** | **FAIL as specified — it is sufficient.** Section 1. Asserting the opposite would have been a false test, so the suite asserts what is true: the first pass covers every required field and the gate correctly skips the second pass |
| **A low-quality scan where the second pass rescues the page** | **NOT VERIFIED** — I could not produce one. Every page I rendered down to 100 dpi was still fully covered by the first pass, and the band pass read the table *worse*. The mechanism is proven on a real image (region read, words, confidence, validation) but no document is yet known where it changes the outcome |
| Blank / rotated page | **PARTIAL** — a page yielding no characters is covered (`failed`, not a false success). Rotation is **NOT VERIFIED**: no rotated fixture |
| The exact PDF committed as a fixture | **NOT DONE, deliberately** — it is a real vendor document carrying a GSTIN, bank account, phone and email. It stays out of the repository and the tests read it from `SOLIVY_GRN_SAMPLE_PDF`; the committed fixtures are masked OCR text |
| Windows development / packaged Windows build | **NOT VERIFIED** — no Windows machine, and this repository still has no Windows installer. PowerShell steps: `GRN-AUTOMATIC-OCR-v2.11.0.md` section 6 |
| `next build` | **NOT VERIFIED** — the npm registry is unreachable here, so Next.js 15.5.27 is not installed |
| Neon; instrumented byte measurement | **NOT VERIFIED** — the online suite is local PostgreSQL and has no GRN upload; no before/after byte comparison was run (recognition issues no request, which *is* asserted) |
| `lint` | **NOT VERIFIED** — `npm run lint` is `next lint`, which needs the uninstalled Next.js |

## 6. Changed files

- `lib/grn/regions.ts` — **new**: anchors, region plans, column rebuild with per-column validation,
  pass combination with provenance, coverage measurement.
- `lib/grn/ocr-wasm.ts` — `recognisePage` (word boxes via TSV, region passes via `SetRectangle`,
  region cap, page restored afterwards).
- `lib/grn/extract.ts` — the gate and the guard, region diagnostics, `second_pass_reason`, the
  image size passed through for clamping.
- `lib/grn/parse.ts` — the wrapped supplier name reassembled, with its note; a dead expression
  removed.
- `tests/integration/grn-regions.test.ts` — **new**, 14 tests.
- `scripts/check-grn.cjs` — 10 new invariants (76 total).
- `package.json`, `CHANGELOG.md`, `WORKLOG.md`, `ARCHITECTURE.md`, `RELEASE-STATUS.md`, this file.

## 7. The sample's expected facts, as read

Page 1 — sample `2627-22603`, date `17.10.2026`, truck suffix `5630`, supplier `AKSH ENTERPRISE`,
bags `375`, received net `21,262 kg`, freight `0`, load/unload `0`, rokdi `0`, moisture `11.50 %`,
deduction `0.00`, threshold `14.00 %`.

Page 2 — Deepak Enterprises, invoice `274`, `13-Oct-26`, vehicle `GJ04X5630`, packages `375`,
Maize, HSN `10059000`, dispatched `218.90 qtl` = `21,890 kg`, rate `₹2,000/qtl` = `₹20/kg`, amount
`₹4,37,800`.

Reported but not corrected, by design: the buyer GSTIN on page 1 is misread by the scanner and is
flagged low confidence with a check-digit note; the seller GSTIN on page 2 picks up a neighbouring
column and is flagged the same way; the quantity unit reads `atl.` for `qtl.` and is converted with
the correction recorded. None is silently fixed.
