# SOLIVY Finance v2.10.1 — GRN import inside Add Purchase, and the crash fix

Baseline: v2.10.0 (GRN pipeline), on v2.9.0 and earlier. No schema change in this release.

## 1. The crash — root cause, not the line

Reported: `app/grn/page.tsx` — `Cannot read properties of undefined (reading 'calculation')` at

```ts
const calc = useMemo(() => purchaseCalc({ ...form, discount_after_quality: result?.draft.calculation.discount_after_quality ?? 1 }), [form, result]);
```

`result?.` guards only `result`. The real defect is a **data-contract assumption**: `/api/grn` does
not always answer with a draft. When no text can be read it answers
`{ ok:false, error, extraction }` and **no `draft`** — and the screen had already stored that
response (`setResult(j)` on the failure path), so `result.draft` was `undefined`.

Fixed at the boundary, not at the call site: **`lib/grn/contract.ts`** normalises every response
into one shape that always has `draft.purchase` (all numeric fields numeric, all text fields
strings), `draft.calculation`, and the arrays the UI iterates. Nothing is fabricated — a missing
value becomes `0` or `''`, the response is marked `complete: false`, and `problems[]` names what was
missing so the screen shows the failure instead of a plausible-looking draft. The calculation is
always recomputed locally from the fields on screen, so the figure shown follows the form.

Both consumers (`/grn` and the new wizard) call `normaliseGrnResponse` and no longer reach into
nested response fields; `scripts/check-grn.cjs` fails the build if `result.draft.calculation`
reappears in the page.

## 2. Import from GRN / PDF, inside the Add Purchase modal

The Purchase screen, the Add Purchase button and manual entry are unchanged. Inside the existing
Add Purchase modal there is now a secondary action **Import from GRN / PDF**, which opens
`app/components/GrnImportWizard.tsx` — a dialog built with the same classes as that modal
(`max-w-6xl`, `rounded-t-3xl` on phones, backdrop click, `role="dialog"`, `aria-modal`), with:

- drag-and-drop or file chooser, upload/recognition progress, and errors in plain words;
- a summary of the **whole document**: page count, how it was read, which page the GRN was found
  on, which page the bill was found on, and **which pages were not recognised** — with the parser's
  limits stated on screen (one GRN, one party bill, the first goods line);
- the source page image beside the extracted fields, with a page selector;
- a row per field: a tick box, the value **currently in the purchase form**, and the value from the
  document (editable), with the page it came from;
- duplicates and review warnings from the existing pipeline;
- a live total through `purchaseCalc` for the ticked values;
- **Back**, **Cancel**, **Close** and **Use in Purchase Form**.

**Merge rule:** a field is ticked by default only where the form is empty. A field you have already
typed is offered but left unticked and marked *"replaces what you typed"*, so replacing your own
entry is always an explicit choice. Only ticked fields are returned; the Add Purchase modal then
shows which fields came from the document. Opening, cancelling or closing the wizard never changes
what you have typed, and **the wizard never posts**: the existing Add Purchase Save remains the only
accounting write path.

Also in this release: a password-protected PDF is now named as such (`ENCRYPTED_PDF`) instead of
being reported as an empty document, and the text-layer threshold was lowered to 12 characters so a
genuinely sparse text page is not sent for recognition it does not need.

## 3. Windows: the local recognition tools

Scanned documents need two tools **on the machine running SOLIVY**. Nothing is sent to any service.

1. **Poppler** (`pdftotext`, `pdftoppm`) — download the Windows build
   (`Release-xx.xx.x-0.zip` from the poppler-windows releases page), unzip to
   `C:\Program Files\poppler`, and add `C:\Program Files\poppler\Library\bin` to the PATH.
2. **Tesseract OCR** — install the UB Mannheim Windows installer (default path
   `C:\Program Files\Tesseract-OCR`), keeping the English language data, and add that folder to the
   PATH.
3. Sign out and back in (so the PATH is picked up), then restart SOLIVY.

If you would rather not change the PATH, set these instead, in the same place as the other SOLIVY
environment settings:

```
SOLIVY_PDFTOTEXT=C:\Program Files\poppler\Library\bin\pdftotext.exe
SOLIVY_PDFTOPPM=C:\Program Files\poppler\Library\bin\pdftoppm.exe
SOLIVY_TESSERACT=C:\Program Files\Tesseract-OCR\tesseract.exe
```

Optional tuning: `SOLIVY_GRN_OCR_DPI` (default 300), `SOLIVY_GRN_OCR_PSM` (default 4),
`SOLIVY_GRN_OCR_LANG` (default `eng`), `SOLIVY_GRN_TEXT_MIN` (default 12).

To check: open Add Purchase → Import from GRN / PDF and upload a scan. If a tool is missing the
wizard names it and the fields can still be typed in by hand; a PDF that has a text layer works
without either tool.

## 4. Verification — what was run, and what was not

Commands: `npx tsc --noEmit -p tsconfig.verify.json`, `npm test`, `npm run test:ui`,
`npm run test:online`, `SOLIVY_GRN_SAMPLE_PDF=… node --test tests/integration/grn-extract.test.ts`,
every `scripts/check-*.cjs`. Evidence: `docs/verification/test-run-2026-11-01-v2.10.1.txt`.

| The brief asked for | Result |
|---|---|
| TypeScript / typecheck | **PASS** — 0 errors |
| Production build (`next build`) | **NOT VERIFIED** — the npm registry is unreachable here, so Next.js 15.5.27 is not installed. Components and routes are exercised through a `next/server` shim and real esbuild+Chromium bundles |
| Existing tests | **PASS** — 112 offline (110 pass, 2 sample-gated), 56 online on PostgreSQL 16, 16 browser, 18 scripts |
| New GRN regression tests | **PASS** — 12 contract/document tests + 6 browser wizard tests |
| Manual Add Purchase with no PDF | **PASS at the API and shell level** — the form and `/api/purchases` are untouched and covered by the existing suites; the modal itself was **not** driven in a browser for a manual save |
| Open wizard, cancel, reopen; manual values intact | **PASS** — browser test: Cancel and Escape both close it, `applied` stays `none`, the typed vehicle number survives |
| Valid two-page PDF; both pages processed and shown | **PASS** — the real sample: GRN on page 1, bill on page 2, both rendered |
| Multi-page PDF; every page processed or reported | **PASS** — a 3-page text PDF reads all 3; a 4-page document reports pages 3 and 4 as unrecognised by number |
| Scanned PDF and text-layer PDF | **PASS** — the real scan via recognition; a jsPDF-built text PDF via the text layer, with no recognition |
| Missing Poppler/Tesseract, OCR failure | **PASS** — with `SOLIVY_TESSERACT` pointed at a missing file the tool is named and the fix is stated |
| Corrupt, encrypted, oversized, unsupported PDF | **PASS** — 415 not a PDF, 400 empty, 422 `ENCRYPTED_PDF`, 413 over 15 MB, corrupt yields a reason and claims nothing recognised; none create an entry |
| Missing `result` / `draft` / `calculation` fields | **PASS** — 8 contract tests plus 2 browser tests on the real failure shapes |
| Duplicate PDF / sample / invoice / vehicle | **PASS** — all four, including the same document by checksum |
| Edit extracted values; `purchaseCalc` totals | **PASS** — browser test: rate 20 → 25 moves the net payable to ₹5,31,550 live |
| Return draft to Add Purchase; nothing posted before Save | **PASS** — the wizard makes exactly one request (`POST /api/grn`) and no `POST /api/purchases` |
| Save once; exactly one purchase and linked records | **PASS** — the workflow test saves once, links the document, and a second identical save is refused |
| Offline and online | **Offline PASS** (SQLite). **GRN on Neon: NOT VERIFIED** — the online suite runs on a local PostgreSQL 16 and does not include a GRN upload |

## 5. Known limitations

1. **Recognition tools are not bundled** (section 3). Without them, text-layer PDFs and manual entry
   still work.
2. **One GRN, one party bill, the first goods line.** Extra consignments, bills or lines are
   reported as unrecognised pages or simply not proposed — never silently imported. The wizard says
   this on screen.
3. **The parser is written for these two layouts** (a Sayaji-style GRN list report and a Tally-style
   bill of supply). Other layouts are reported as unrecognised rather than mapped wrongly.
4. Values with no check digit (weights, rates) can only be checked by eye; every field shows its
   confidence and source page for that reason.
5. The original PDF is optional and stays on the machine it was uploaded on (it is excluded from
   synchronisation); the audit record and extracted text do synchronise.
6. `next build` and Neon remain unverified in this environment.
