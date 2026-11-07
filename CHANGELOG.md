# Changelog

## 2.12.3 — 2026-11-07 (inter-company transfer: choosing the destination's account)
Built on v2.12.2. No schema change, no new API route, no new network call, no sync change, no change
to any financial calculation. Details in `TRANSFER-ACCOUNT-MAPPING-v2.12.3.md`.
- **Fixed: accepting a transfer failed with `Destination organization is missing mapped bank/cash
  account: Aksh Ent.`** A transfer carried its parties and accounts by name and the destination had
  to hold one named identically. It failed at acceptance — after the transfer was already PENDING —
  naming no record, no field and no account the destination has, with no way out but renaming
  master data.
- The receiver now **chooses**. Acceptance returns HTTP 409 `MAPPING_REQUIRED` listing each
  unresolved link with the record and field that need it and every account (or candidate party) the
  organization actually has; the receiving screen renders a chooser, and *Accept with these choices*
  imports the transfer. Nothing is renamed in either organization.
- Where the destination simply lacks the account, the chooser offers *Create "<name>" here instead*,
  adding it with the source's name, bank and type and a **zero opening balance of its own**. Parties
  are not created this way — a vendor master's GST, PAN and TDS settings must be entered deliberately.
- **Nothing is guessed.** A near match ("AKSH ENTERPRISES" for "Aksh Ent.") is offered as a
  suggestion to confirm and is never applied on its own; a source check holds that in the code.
- The import is **all or nothing**: every link is checked before the transaction opens, so a refusal
  imports nothing and leaves the transfer PENDING and still acceptable.
- `create` now reports `unresolved_links` and names what the destination cannot match, so the sender
  learns at send time instead of at acceptance. A read-only `preflight` action reports the same
  without writing anything.
- What was mapped is recorded on the `INTERCOMPANY_TRANSFER_ACCEPTED` audit entry and the acceptance
  receipt. Identity matching itself is unchanged, the ledger bundle still matches parties by name
  alone, and a map may not point outside the destination organization.
- Transfers had **no tests**; there are now 10 offline and 1 online through the PostgreSQL bridge,
  including the reported `money_in` case, and `check-transfers.mjs` grew from 17 invariants to 32.

## 2.12.2 — 2026-11-05 (advice: the commercial bill's treatment only; bags on the bills)
Built on v2.12.1. No schema change, no new API route, no new network call, no sync change, no change
to `purchaseCalc`. Details in `PAYMENT-ADVICE-MOISTURE-v2.12.2.md`.
- **Reverted the payment advice's layout to what it was.** v2.12.1 added two information rows and a
  note paragraph to each settled bill on the advice; those are removed. The moisture percentage now
  rides in the existing "Less: Moisture Deduction (…)" row's label and the money sits in the amount
  column — exactly the treatment the commercial bill already had, and nothing more. The two advice
  settings v2.12.1 introduced are removed with the rows they controlled, and the threshold lookup
  added to the query is removed with them.
- The v2.12.1 fix itself stands: the advice and the bills share one deduction rule, so under the
  rate-per-kg quality rule the quality deduction appears **once** with the percentage in its label
  rather than a percentage printed as rupees plus a separate quality row. The advice's original row
  order — unload, freight, moisture, discount, rokdi, quality, other — is preserved.
- **Added — a Bags column on the commercial and third-party bills**, listed in Document Settings as
  "Bags / Packages column". Off by default, so existing bills print unchanged; turn it on and switch
  Quantity off to show packages instead of weight, or show both, in which case Bags prints after HSN
  and before Quantity. It prints the purchase's `bags_qty` and nothing when none was recorded, and
  changes no money. Added in `lib/documents/bill-model.ts`, so all five templates get it.
  The purchase bill has its own column list and was not changed.
- Tests: `tests/integration/bill-bags-column.test.ts` (8 new, including a Document Settings
  round-trip); the advice tests trimmed to the deduction behaviour; 193 offline, 57 online
  (PostgreSQL 16.15), 22 browser, 25/25 source scripts, typecheck clean. Rendered evidence:
  `docs/verification/payment-advice-moisture-v2.12.2.pdf`. **NOT VERIFIED:** `next build`,
  `next lint`, Neon, Windows.

## 2.12.1 — 2026-11-05 (payment advice: moisture always shown, quality deduction by the approved rule)
Built on v2.12.0. No schema change, no new API route, no new network call, no sync change, and no
change to `purchaseCalc`. Details in `PAYMENT-ADVICE-MOISTURE-v2.12.1.md`.
- **Fixed — the payment advice printed a recorded moisture percentage as a rupee deduction.** The
  advice built its own deduction list, separate from the bills', and its query never selected
  `quality_deduct_rate_per_kg`. A purchase saved under the rate-per-kg quality rule therefore looked
  legacy to it: 11.50 % moisture printed as "Less: Moisture Deduction (11.5%) ₹11.50", money the
  accounting record never deducted, leaving the rows adding to 21.50 against a stored total of 10.
  Selecting that column alone would have printed the same ₹10 twice, as moisture and as quality.
- `lib/documents/advice-model.ts` (new) holds the rule once and both documents use it: under the
  rate-per-kg rule the quality deduction **is** the moisture deduction and appears once with the
  percentage in its label; under the legacy rule the stored moisture amount is the deduction and
  quality is listed separately. A test asserts the advice and the bills produce identical rows.
- (Superseded by 2.12.2, which removed these: moisture stated on its own row, the supplier's
  threshold shown as information, and the quality deduction's basis. The advice's layout is
  unchanged from 2.12.0 again, and the percentage rides in the deduction row's label.)
- **No threshold formula was invented.** `purchaseCalc` has no threshold and no per-excess rate;
  excess moisture is therefore not shown, and a new source check fails the build if a threshold ever
  starts multiplying anything in this path.
- **Added a review note where the figures cannot both be true:** without a quality rate the
  calculation deducts the moisture field itself, so one number serves as both the reading and the
  rupees. The advice says so, names the threshold it sits below, and states that nothing was altered.
  A stored value above 100 is reported as not a percentage rather than printed as one.
- Added a reconciliation note for the case where the rows fail to add up to the stored
  `total_deduction` with every row enabled; a row switched off is the user's choice, not a mismatch.
- Two new Document Settings, on by default: `show_moisture_percent`, `show_quality_basis`.
- Tests: `tests/integration/payment-advice-moisture.test.ts` (14 new) and one online parity test
  through the PostgreSQL bridge. 192 offline, 57 online (PostgreSQL 16.15), 22 browser, 25/25 source
  scripts (`check-payment-advice.cjs`, 13 invariants), typecheck clean. Rendered evidence:
  `docs/verification/payment-advice-moisture-v2.12.1.pdf`. **NOT VERIFIED:** `next build`,
  `next lint`, Neon, Windows.

## 2.12.0 — 2026-11-02 (a consignment list is many GRNs; every page of a document is read)
Built on v2.11.2. No schema change, no new API route, no new network call, no sync change. Details
in `GRN-MULTI-DOCUMENT-v2.12.0.md`.
- **Fixed — only the first GRN and the first bill of an upload were read.** On the supplied
  thirteen-page S M CORPORATION scan that meant one purchase out of twelve and one bill out of
  eleven; the rest were discarded without a word. `lib/grn/multi.ts` now reads the whole document.
- **Every data row of a consignment list is its own GRN**, in printed order, with a stable identity
  from its page and position, all eleven columns, and its own draft purchase built by the existing
  `buildDraft` and priced by the existing `purchaseCalc`. The Total row is never a GRN.
- **Every page is classified and kept** — GRN list, tax invoice, bill of supply, handwritten slip or
  not recognised — with fuzzy heading matching, because these scans read "Bill of Supply" as
  "Billof suenly".
- **Goods lines are read from the column order the bill prints**, so the tax-invoice and Tally
  layouts both work without either being hardcoded. Line, product, HSN, packages, quantity, unit,
  rate, per, amount and round-off are separate fields.
- **The rate is never derived from the amount.** Where it is not printed or could not be read it
  stays empty and `calculated_check` carries amount ÷ quantity, labelled a check. Where it is
  printed, quantity × rate is checked against the amount and a disagreement is reported, not fixed.
- **The printed Total is a cross-check.** The rows are summed and compared column by column; on
  this document they disagree on bags, net weight, rokdi and deduction, and every row is left
  exactly as read.
- **Links need corroborating evidence** — vehicle tail, bag count, supplier name, close dates — with
  the evidence listed, ties reported for confirmation and weak matches left unlinked.
- **Nothing is placed where it does not belong.** A row or a line with more figures than columns
  keeps what is certain and leaves the rest empty with every figure listed, rather than shifting a
  number into a financial field.
- **The wizard lists all the consignments** with their columns, matched bill and warnings, and takes
  them one at a time. Add Purchase → Save is still the only write path; a list is never combined
  into one purchase.
- Both bill parsers now run and the layout-specific one fills what the column-driven one leaves
  empty, so support for new layouts cannot make an old one read worse.
- Tests: `tests/integration/grn-multi.test.ts` (14 new, against the real document) and 2 browser
  tests; masked OCR fixtures committed for the list, a tax invoice and a bill of supply. 178
  offline, 56 online (PostgreSQL 16.15), 22 browser, 24/24 source checks (`check-grn.cjs` now 100),
  typecheck clean. **NOT VERIFIED:** rotated pages, several list pages, a GRN spanning pages,
  many-bills-to-one-row; `next build`, `next lint`, Windows, Neon, byte measurement. The 13-page PDF
  is deliberately not committed — it carries three suppliers' GSTINs, bank accounts and contacts.

## 2.11.2 — 2026-11-02 (the OCR engine would not load on a real installation)
Built on v2.11.1. No schema change, no new network call, no sync change. Details in
`GRN-OCR-LOADER-FIX-v2.11.2.md`.
- **Fixed — `undefined is not a function` on every page, reported from a live installation.** The
  engine never loaded, so both pages were recorded as unreadable and the wizard fell through to
  manual entry. The cause was module loading, not OCR: `createRequire`, imported from `node:module`,
  can come back undefined once the file has been through the Next.js server bundler, and calling it
  gives exactly that message. It worked under the test runner, which is why every suite passed while
  the installation failed.
- The engine file is now loaded by **five guarded routes** tried in order — the static
  `createRequire`, `createRequire` from a run-time `import('node:module')`, the module's own
  `require`, `require` fetched through `eval`, and `import('file://…')` of the engine itself — each
  checked with `typeof` before use. Every route is proven independently: a test loads the engine
  through each one on its own, and `SOLIVY_GRN_OCR_LOAD_ROUTES` can pin a build to a route that
  works.
- **The engine's own interface is checked before it is called** (`FS.writeFile`, `TessBaseAPI`,
  `Init`, `SetImageFile`, `Recognize`, `GetUTF8Text`, `SetPageSegMode`), and a module that loads but
  exports the wrong shape is reported rather than invoked. No path can produce a bare
  `undefined is not a function` again.
- **A load failure now says what to do:** one note naming the file, stating that it is present and
  that this is a module-loading problem, and listing every route tried with its reason — shown in
  the wizard's diagnostics panel too, instead of a type error repeated per page.
- **Added `GET /api/grn?selftest=1`** — loads the engine and reports its version, the load route,
  the folder, the languages, the Node version and platform, or every failed attempt with 503. It
  uploads nothing, reads no document and stores nothing.
- **Fixed — a cached engine was reused after the configured folder changed**, so a diagnostic could
  report success for an engine no longer there. It is now tied to the folder it came from, and the
  self-test reports what is on disk now.
- **Fixed — `No existing party matches "the seller"`**: a placeholder was presented as a name when
  no bill was recognised. It now says no seller was read and the party must be chosen by hand.
- Tests: `tests/integration/grn-ocr-loader.test.ts` (9 new); 164 offline, 56 online (PostgreSQL
  16.15), 20 browser, 24/24 source checks (`check-grn.cjs` now 86), typecheck clean. **NOT
  VERIFIED:** that this fixes the reporting installation — a Next.js server build cannot be
  reproduced here (no npm registry), so the self-test above is how to confirm it; also `next build`,
  `next lint`, Windows, Neon and an instrumented byte measurement.

## 2.11.1 — 2026-11-02 (a targeted second OCR pass; the wrapped supplier name)
Built on v2.11.0. No schema change, no new API route, no new network call, no sync change. Details
in `GRN-REGION-OCR-v2.11.1.md`.
- **Fixed — a supplier name the document prints wrapped was truncated.** `PO Supplier` is a narrow
  column, so `AKSH ENTERPRISE` is printed across three lines and OCR returns it that way; the
  parser took only the fragment inside the data row and reported `ENTERPRIS`. The neighbouring
  lines are now folded back into the cell, giving `AKSH ENTERPRISE`, with a note saying it was
  reassembled and what the row itself read.
- **Added — a second, targeted OCR pass** (`lib/grn/regions.ts`, `recognisePage`). The first pass's
  word boxes locate regions from the labels printed on the page — never from pixel coordinates
  fixed for one document, so the same page at another resolution yields the same region scaled, and
  a page without those labels yields none. Regions are read with `SetRectangle` on the image
  already loaded: no crop, no copy, no second decode, at most 4 regions a page, inside the existing
  time budget.
- **The pass is gated and guarded.** It runs only when the first pass left a required field unread,
  judged by the real parser, and its result is kept only if coverage is strictly better than the
  first pass's. Measurement drove this: on the supplied document the band-level pass reads the
  table *worse* than the whole page, so the guard discards it. A second pass can add a missing
  cell; it cannot spoil a page that was already read correctly.
- **A rebuilt table row is validated per column** — a date in the date column, digits in the weight
  column — and the whole rebuild is discarded if any cell does not fit, rather than handing a
  mislabelled weight to the parser.
- **Added diagnostics:** the image dimensions given to recognition, and per region the name,
  rectangle, characters, confidence and duration, plus `second_pass_reason` stating whether the
  first pass sufficed, which fields were missing, or that the regions added nothing.
- **The brief's diagnosis did not reproduce.** With the bundled engine the whole-page pass already
  reads the full GRN row of the supplied PDF (`2627-22603 | 17.10.2026 | 5630 ENTERPRIS 375 21262 0
  0 0 11.50 0.00`), so the required fields were never missing; the measurement in the brief was
  taken with the system Tesseract on extracted JPEGs. The suite therefore asserts what is true —
  the first pass is sufficient and the gate skips the second pass — instead of the opposite.
- Tests: `tests/integration/grn-regions.test.ts` (14 new, including the engine's region pass on a
  real rendered image and a second GRN layout); 155 offline, 56 online (PostgreSQL 16.15), 20
  browser, 24/24 source checks (`check-grn.cjs` now 76), typecheck clean. **NOT VERIFIED:** a scan
  where the second pass changes the outcome (none found), a rotated page, Windows, `next build`,
  `next lint`, Neon, and an instrumented byte measurement.

## 2.11.0 — 2026-11-02 (scanned GRN pages are recognised automatically)
Built on v2.10.2. No schema change, no new API route, no new network call, no sync change. Details
in `GRN-AUTOMATIC-OCR-v2.11.0.md`; licences in `vendor/tesseract-wasm/NOTICE.md`.
- **Added — the OCR engine ships inside SOLIVY.** `vendor/tesseract-wasm/` carries a WebAssembly
  build of Tesseract plus English language data (Apache-2.0, provenance commits and SHA-256
  checksums recorded). A scanned GRN is now recognised with nothing installed: no Tesseract, no
  Poppler, no `PATH` entry, no environment variable, no internet. `lib/grn/ocr-wasm.ts` loads it
  from a path resolved from the module's own location, never the working directory and never `PATH`,
  and recognises the page image already embedded in the PDF.
- Measured on the supplied two-page scan with the installed tools removed and `PATH` emptied:
  page 1 in 5.7 s at confidence 89, page 2 in 8.0 s at confidence 70; the parser then found the
  sample number, GRN date, truck, bags, received weight, moisture and threshold, and the supplier,
  invoice, date, vehicle, packages, Maize, HSN 10059000, 218.90 qtl = 21 890 kg dispatched,
  ₹2,000/qtl = ₹20/kg and ₹4,37,800.
- **Recognition stays local.** No cloud OCR, no telemetry, no OCR endpoint and no per-page request:
  zero API calls and zero Neon transfer, asserted by a test that fails if `fetch`/`http` is reached
  while a document is read. Works with the network disconnected.
- **A page is recognised only when the parser finds its fields**, never because OCR returned
  characters. Dispatched (21 890 kg) and received (21 262 kg) weights stay distinct; no moisture
  deduction is created at 11.50 % against the 14 % threshold the GRN itself prints; pages are linked
  on vehicle, package count and date, with the reasons shown and contradictions flagged.
- **Added — diagnostics.** "Show how this document was read" reports the engine kind, Tesseract
  version, engine and tessdata paths, languages, requested language, PSM, page count, total time
  and, per page, status, engine, duration, character count and confidence. Local only; not synced,
  and the recognised text is not logged.
- Bounded and recoverable: 15 MB, 25 pages, a 180 s recognition budget
  (`SOLIVY_GRN_OCR_BUDGET_MS`) after which pages are marked *not attempted* rather than assumed
  read. Missing engine, missing language data, a page with no image, a page that yields no
  characters, and the existing corrupt/encrypted/oversized refusals each have their own message.
- **Fixed — a text-layer PDF no longer warns about OCR it never needed.** The engine's
  unavailability is now surfaced only when a page actually requires recognition.
- **Fixed — the engine loader failed under ESM and the test runner** (`require is not defined`
  inside a `new Function` body, which sees only global scope). It now uses `createRequire`.
- Manual entry is kept as the last resort for a machine where no engine can be used at all.
- Tests: `tests/integration/grn-ocr-bundled.test.ts` (12, installed tools removed); 141 offline,
  56 online (PostgreSQL 16.15), 20 browser, 24/24 source checks (`check-grn.cjs` now 66
  invariants), typecheck clean. **NOT VERIFIED:** Windows development, a packaged Windows build
  (this repository has no Windows installer to extend), `next build`, Neon, and an instrumented
  byte measurement.

## 2.10.2 — 2026-11-01 (the GRN import works with nothing installed)
Built on v2.10.1. No schema change, no new dependency, no new network call. Details in
`GRN-NO-TOOLS-v2.10.2.md`.
- **Fixed — the import could do nothing on a machine without poppler and tesseract.** Every step
  had been delegated to those tools, so with neither installed the wizard could only name what was
  missing. `lib/grn/pdf-native.ts` (new) now reads the PDF in plain JavaScript using Node's `zlib`
  alone: the real page count from the page tree, the text layer decoded from the content streams,
  and the page images lifted out of the file (`/DCTDecode` is already a JPEG; an 8-bit
  `/FlateDecode` DeviceRGB/Gray page is re-wrapped as PNG). A text-layer PDF now imports exactly
  with nothing installed at all.
- **Fixed — a fabricated page count.** With no text-layer tool the extractor reported its own scan
  limit ("20 page(s)") for a two-page document. The count is now the document's, always.
- **Fixed — recognition no longer needs poppler.** Tesseract is given the page's own embedded image
  and told the resolution worked out from the page geometry. Verified on the supplied scan: every
  field comes through identically to the poppler path.
- **Fixed — an installed tool that is not on the PATH is now found.** `Program Files`,
  `Program Files (x86)`, `%LOCALAPPDATA%\Programs`, `ProgramData`, chocolatey, scoop and an
  unzipped `poppler*` / `Release-*` folder are searched too. The `SOLIVY_*` overrides still win.
- **Changed — a document that cannot be read is a manual entry, not a refusal.** `/api/grn` answers
  200 with `manual_entry: true` and a complete but entirely empty draft; the wizard shows the pages
  beside every field, guesses nothing, ticks a field as it is typed, and keeps the live total. A
  PDF with no pages at all is still refused, with that as its reason. The wizard still posts
  nothing.
- Corrected two stale source-invariant markers: `check-sync.mjs` (the device-token header moved to
  `lib/sync-auth.ts`) and `check-grn.cjs`.
- Tests: `tests/integration/grn-native.test.ts`, 13 new tests with all three tools forced absent,
  plus one browser test for manual entry. 129 offline, 56 online (PostgreSQL 16.15), 17 browser,
  24/24 source checks, typecheck clean. `next build` and Neon remain unverified here.

## 2.10.1 — 2026-11-01 (GRN import inside Add Purchase; crash fix)
Built on v2.10.0. No schema change. Details in `GRN-IMPORT-MODAL-v2.10.1.md`.
- **Fixed — `Cannot read properties of undefined (reading 'calculation')`.** The screen assumed a
  response shape `/api/grn` does not always return: an extraction that reads no text answers with
  `extraction` and an error and **no draft**, and the failure path had stored that response. Fixed
  at the contract, not the line: `lib/grn/contract.ts` normalises every response into one shape
  with a draft, a purchase (numeric fields numeric) and a calculation, marks it `complete: false`
  and lists what was missing. Nothing is fabricated; the calculation is recomputed from the fields
  on screen. A guard script fails the build if the unguarded access returns.
- **New — Import from GRN / PDF inside the existing Add Purchase modal.** A dialog in the same
  style (`app/components/GrnImportWizard.tsx`): drag-and-drop, progress, page count, which page the
  GRN and the bill were found on, which pages were not recognised, the page image beside the
  fields, duplicates and warnings, a live `purchaseCalc` total, and Back / Cancel / Close /
  **Use in Purchase Form**. The `/grn` page remains for standalone use.
- A field is ticked by default only where the form is empty; a value you typed is offered but left
  unticked and marked "replaces what you typed". Only ticked fields are returned, and the Add
  Purchase modal shows which came from the document. The wizard never posts — the existing Add
  Purchase Save is still the only accounting write path — and opening or cancelling it never
  disturbs what has been typed.
- A password-protected PDF is now named (`ENCRYPTED_PDF`) instead of reported as empty; the
  text-layer threshold is 12 characters, so a sparse text page is not sent for recognition.
- Windows setup for Poppler and Tesseract is documented, with environment-variable overrides.
- Tests: 112 offline (110 pass, 2 sample-gated), 14/14 with the real sample PDF, 16 browser
  (6 new, driving the wizard in Chromium), 56 online (PostgreSQL 16), 18 scripts, typecheck clean.
  `next build` remains NOT VERIFIED (no npm registry). Evidence:
  `docs/verification/test-run-2026-11-01-v2.10.1.txt`.

## 2.10.0 — 2026-11-01 (GRN document to draft purchase)
Built on v2.9.0; earlier releases unchanged. Details in `GRN-TO-PURCHASE-v2.10.0.md`. Schema 30
(adds `grn_documents` and the local-only `grn_document_files`; no business table changed).
- **New — upload a GRN with its party bill and get a draft purchase to review.** `POST /api/grn`
  extracts, matches and proposes; it posts no accounting entry. The reviewed values are saved by
  the existing `POST /api/purchases`, so there is one accounting path and nothing recognised can
  reach the ledger without a person confirming it. The screen is at `/grn`.
- Extraction runs locally and adds no dependency: an embedded text layer when the PDF has one,
  otherwise poppler + tesseract if present on the machine (`SOLIVY_PDFTOTEXT`, `SOLIVY_PDFTOPPM`,
  `SOLIVY_TESSERACT`). Nothing is sent to an external service. A missing tool is named and manual
  entry against the rendered pages remains.
- The parser is written against the real supplied scan and its real recognition output. **The bill
  quotes per quintal, not per kilogram as the brief expected**, so the unit is read from the page
  and converted (₹2,000/qtl = ₹20.00/kg); an unrecognised unit blocks the draft.
- Mapping: GRN date, sample number, bags, received weight (net) and charges from the GRN; vehicle,
  invoice, HSN, goods and rate from the bill; the bill quantity as the gross weight with the
  difference shown. The GRN's moisture **percentage** is reported, not written into `moisture`,
  which `purchaseCalc` treats as a rupee deduction — and the GRN's own 14% threshold is quoted.
- Party matched by GSTIN, then name, then alias; a party and bank draft is offered when there is no
  match. A GSTIN or IFSC that fails validation is reported as read and left out of the record.
- Duplicates are caught before re-entry: same document checksum, same sample number, same invoice
  for the party, same vehicle and date. A document linked to a purchase cannot be discarded.
- Tests: 104 offline (102 passed, 2 reported NOT VERIFIED without the uncommitted sample document),
  14/14 with the real sample PDF including the whole workflow through the real endpoints, 56 online
  (PostgreSQL 16), 10 browser, 18 legacy scripts, typecheck clean. Evidence:
  `docs/verification/test-run-2026-11-01-v2.10.0.txt`.

## 2.9.0 — 2026-10-31 (bidirectional sync + full database clone)
Built on v2.8.0–v2.8.3, all unchanged. Architecture and recovery steps in
`CLONE-AND-SYNC-ARCHITECTURE-v2.9.0.md`. No business schema change.
- **Root cause of the endless conflicts, named.** Online storage holds the whole organisation
  SQLite file in PostgreSQL as page-aligned chunks; device ⇄ hub sync is event replication on top.
  Event replication can only converge from a common ancestor, so two databases that had drifted
  apart produced a conflict per record, and resolving one exposed the next. A clone establishes that
  ancestor; `realignAfterClone` then puts the journal and cursor in the one state where incremental
  sync is correct from that point.
- **New — full clone engine, both directions.** `lib/clone-engine.ts` + `lib/clone-store.ts` +
  `/api/sync/clone` (hub) + `/api/sync/clone/run` (device). Consistent snapshot (`VACUUM INTO`,
  never a live WAL copy) → validation (integrity, foreign keys, schema version, accounting
  invariants) → fingerprint (per-table rows and content hashes plus 16 financial aggregates) →
  staging (a separate key online, a temporary file offline) → read-back verification that must match
  the source exactly → activation with the replaced copy kept for rollback. Any failure aborts
  before activation and leaves both databases untouched.
- **New — resumable chunked transfer.** 1 MiB per request; every upload chunk is stored in
  PostgreSQL keyed by (upload_id, chunk_no), so a resend is idempotent and an interruption or an
  application restart resumes from what arrived (the upload id is derived from the snapshot's
  sha256). A commit with any chunk missing is refused and names the missing ones. Downloads are
  checksum-verified per chunk and retried. One clone per organisation and environment at a time,
  enforced by a lock row other instances can see.
- **Fixed — a clone would have broken sync silently.** A snapshot carries the other side's
  `sync_meta`, so activating it verbatim made the receiving side adopt the sender's device id; the
  pull filter (`origin_device <> me`) then discarded that side's own changes and hub changes never
  arrived. Reproduced in the test suite, then fixed: each side keeps its own identity and pairing.
- **New — dashboard.** The Sync screen now shows clone and health status (uploaded/downloaded
  counts, records awaiting review, last successful sync) with five actions: preview or run a full
  push, preview or run a full pull, validate both databases, roll back the online copy. A preview
  changes nothing; running a clone needs `REPLACE ONLINE|OFFLINE <organisation> <LIVE|TEST>` typed
  exactly and an administrator session.
- Carried forward unchanged: per-item rejection with quarantine and replay, no auto-merge of
  financial conflicts, POSTED records corrected by reversal only, deactivation instead of deleting a
  party with history, LIVE/TEST and organisation isolation.
- Tests: 90 offline (real SQLite), 56 online (real PostgreSQL 16, including 10 new clone tests), 10
  browser, 17 legacy scripts, typecheck clean — all passing. Evidence:
  `docs/verification/test-run-2026-10-31-v2.9.0.txt`.

## 2.8.3 — 2026-10-31 (party DELETE sync conflict)
Built on v2.8.0 / v2.8.1 / v2.8.2, all unchanged. Details in `PARTY-DELETE-SYNC-v2.8.3.md`. No schema change.
- **Fixed — `parties · DELETE · id 15` / "FOREIGN_KEY: Referenced tables not discoverable from this
  table schema."** Two defects: the device-side apply deleted the row with no dependency guard (the
  hub had one), so SQLite raised a bare foreign-key error; and the message was built from
  `PRAGMA foreign_key_list(parties)`, which lists what parties points at — nothing — while the
  blockers are the 12 foreign-key columns in 11 tables that point at it.
- **New `lib/sync-fk.ts`** resolves both directions from the live schema and returns the blocking
  tables, columns and record ids. `describeForeignKeyFailure` is operation-aware: a DELETE lists the
  blockers with their ids, an INSERT/UPDATE still lists its parents. Both sync routes share it.
- **Fixed — a failed dependency probe no longer reads as "no dependents."** `dependentsOf` swallowed
  errors and returned nothing, which let a blocked deletion reach the database.
- **Device-side DELETE now runs the hub's guards**: posted records are never deleted, a stale
  deletion cannot discard a newer record, and a referenced record raises `HAS_DEPENDENTS` naming
  every blocking table and record id. Nothing is deleted and the item stays retryable.
- **New — deactivate instead of delete.** `POST /api/sync/rejects {action:'deactivate'}` sets
  `active=0` on `parties`, `third_parties`, `company_accounts`, `godowns` or `companies` as a
  journalled UPDATE, so the other device receives the same state, every referencing record is kept,
  and the queued deletion is resolved idempotently. Explicit request only; offered on the Sync
  screen as "Deactivate instead"; refused for financial tables with the reason.
- Undeclared conventional references (such as `purchases.broker_party_id`, which has no foreign key)
  are reported as "would be left dangling" rather than passing unnoticed.
- Foreign keys are never disabled, financial history is never cascade-deleted, and a queued deletion
  is never discarded automatically.
- Tests: 90 offline (real SQLite), 46 online (real PostgreSQL 16), 10 browser, 16 legacy scripts,
  typecheck clean — all passing. Evidence: `docs/verification/test-run-2026-10-31-v2.8.3.txt`.

## 2.8.2 — 2026-10-31 (API compatibility guard + packaging fix)
Built on v2.8.0 / v2.8.1, both unchanged. Details in `API-COMPATIBILITY-v2.8.2.md`. No schema change.
- **Fixed — the cause of the reported `GET /api/data … → 404`: `app/api/data/route.ts` was missing
  from the v2.8.1 release ZIP.** The staging command used `tar --exclude=data`, which matches a
  directory named `data` at any depth, so `app/api/data/` was dropped along with the runtime data
  directory. v2.7.1–v2.8.0 contain the file; v2.8.1 was the only package that lost it, and it lost
  nothing else. Excludes are now anchored and every package is verified after extraction before
  delivery. **Replace any deployment built from v2.8.1.** The source was never missing the route:
  the inventory against the v2.8.0 ZIP shows 0 routes and 0 methods lost (68/110 → 69/112, the only
  addition being `sync/rejects`), and the literal request returns 200 in LIVE and TEST for an
  authorised user of organisation 2 with isolation intact.
- **Fixed — the container image could not start.** The Dockerfile runtime stage did not copy
  `scripts/` or `next.config.mjs`, while `npm run start` runs `scripts/ensure-local-secret.cjs`
  first, so the image failed with "Cannot find module". Both are now copied.
- **New — API surface guard.** `scripts/api-route-manifest.json` records every route and exported
  method; `scripts/check-api-routes.cjs` (`npm run check:api-routes`, in the release gate) fails on
  any loss and can be run against an unpacked release to catch a route dropped from a package.
- **New — package guard.** `scripts/check-release-package.mjs` (`npm run check:release-package -- <dir>`)
  compares an unpacked release with the checkout file by file and fails on anything missing, then runs
  the API surface guard over it; run against the v2.8.1 package it names the missing route at once.
- **New — live probe.** `scripts/check-api-live.mjs` (`npm run check:api-live -- <base-url>`) reports
  the status of every GET route on a running deployment and lists the ones answering 404. Read-only.
- **New — `tests/integration/api-compat.test.ts`**: every route exports a method; `/api/data` exports
  GET; every API path the interface fetches resolves to a route exporting the method it uses
  (collected from the source); the reported request and organisation/environment isolation.
- `applyLocal` moved from `app/api/sync/run/route.ts` to `lib/sync-apply.ts`, unchanged, so the
  quarantine retry path no longer imports one route module from another.
- Tests: 84 offline (real SQLite), 44 online (real PostgreSQL 16), 10 browser, 16 legacy scripts,
  typecheck clean — all passing. Evidence: `docs/verification/test-run-2026-10-31-v2.8.2.txt`.

## 2.8.1 — 2026-10-31 (P0 synchronization repair)
Built on v2.8.0, which is unchanged as the rollback baseline. Details in `SYNC-REPAIR-v2.8.1.md`.
Schema 29 (adds the local-only `sync_rejects` table; no business table changed).
- **Fixed — one unapplicable item no longer blocks the whole queue.** Both apply paths ran the
  entire batch in a single transaction, so any single rejected event rolled back every other change
  in it; the push then marked nothing as pushed and the pull committed no cursor, so the next
  attempt re-sent the same batch and failed on the same item forever. Each event now applies in its
  own transaction: valid items go through, the blocking item is quarantined with its table, record
  key, operation and reason, and it stays retryable.
- **Fixed — "Table is not eligible for synchronization." named no table and was decided three
  different ways.** The hub, the device, the resolver and the trigger builder each carried their own
  `excluded` set with different memberships (`login_attempts` only in one; `sync_resolution_log` and
  `sync_conflict_history` missing from the device copy), so a table journalled on one side could be
  refused on the other. Eligibility is now one shared rule (`lib/sync-eligibility.ts`) that names the
  table and says why; per-device bookkeeping queued by an older build is acknowledged and discarded
  as obsolete instead of blocking the queue.
- **Fixed — a record absent on both sides raised a generic conflict.** Every operation hit the same
  "the base record was deleted" error. The outcome is now deterministic per operation
  (`lib/sync-absent.ts`): a deletion whose record is already gone is agreement and a no-op; an edit
  to a record this side never received restores it; an edit against a record deliberately deleted
  here does not resurrect it and is kept in the quarantine instead of being discarded.
- **New — safe retry / reconcile path.** `/api/sync/rejects` lists each set-aside item with the live
  local record, the incoming record and the safe resolutions, and replays it from storage (not from
  the sync cursor), so an advanced cursor can never make a change unrecoverable. "Do not retry" is
  recorded in `sync_rejects` rather than dropping the change silently. The Sync screen shows the
  list with Retry and Do-not-retry.
- **New — diagnostics.** One correlation id per sync run, carried on every request and returned to
  the caller; rejections log table, record key, operation, device, code and that id only — no row
  values, amounts, narrations or references.
- Unchanged: financial conflicts are still never auto-merged, POSTED records are still corrected by
  reversal, stale deletions still cannot remove newer records, dependents are still only removed on
  confirmation, resolutions are still idempotent, and LIVE/TEST and organisation isolation are intact.
- Also fixed (found by the test run): the Neon transfer-budget month-end projection computed the
  month length from a local date while the month itself is UTC, so in any zone ahead of UTC it used
  the wrong number of days and understated usage on a month's last day (`lib/transfer-budget.ts`).
- Tests: 78 offline (real SQLite), 44 online (real PostgreSQL 16), 10 browser, 15 legacy scripts —
  all passing. Evidence: `docs/verification/test-run-2026-10-31-v2.8.1.txt`.


## 2.8.0 — 2026-10-30 (SaaS redesign + sync fix)
Built on v2.7.3 (this repository has no v2.7.5). Details in `RELEASE-NOTES-v2.8.0.md`.
- Sync: delete / missing / recreate conflicts can now be resolved at all — push a deletion, accept
  one, or clear a both-deleted conflict; dependents are listed and only removed on confirmation;
  POSTED financial records are never deleted (reversal instead); a stale deletion cannot remove a
  newer record; resolutions no longer echo back and are idempotent on retry.
- Sync: the resolution log and conflict history are no longer synchronised.
- Purchase register: the register and the purchase form now show the same Net Payable. Records keep
  the discount base they were saved with (new nullable `purchases.discount_after_quality`, schema
  28); legacy rows resolve the rule that reproduces their stored total; unreproducible rows are
  flagged, never rewritten.
- Redesign: light/dark/system themes with seven accents (persisted), four-group sidebar (Vendor
  Ledger, Tally Export, GST Filing and Secondary Backup unlisted but fully working), new profile and
  settings module, loading skeletons, animated figures, mobile drawer and touch sizing.
- Tests: 72 offline, 36 online (PostgreSQL 16), 10 browser, 22 legacy scripts.

## 2.7.3 — 2026-10-30 (moisture display fix)
Display only. No financial logic, stored value, total or database change; `lib/utils.ts
purchaseCalc` is untouched and every stored figure was asserted unchanged by the tests.
- New `lib/documents/moisture.ts` is the single source of truth for how moisture is shown: the
  percentage as a percentage, the deduction as the amount the existing calculation already applied.
- Fixed: a moisture percentage could be printed as a rupee deduction. Bills (all five templates,
  PDFs and previews), payment advice, the Purchase/Sample screen and the purchases export now show
  `Moisture Deduction (20%)` with the calculated amount in the money column.
- One moisture row only, so nothing is deducted twice; under the rate-per-kg quality rule the
  quality deduction is the moisture deduction, as before.
- A stored value above 100 cannot be a percentage (legacy rupee entries), so no percentage is
  claimed for it. Nothing is shown when no moisture was entered.
- Purchases export now has `moisture_percent` and a derived `moisture_deduction` column.

## 2.7.2 — 2026-10-30 (NEON GUARD)
Details in `RELEASE-NOTES-v2.7.2.md`; measurements in `docs/PERFORMANCE-v2.7.2.md`.
- Every route and method declares READ / WRITE / NO_DB in `lib/api-access.ts`, enforced by the
  bridge and audited by `npm run check:api-access` (68 routes, 92 checks).
- READ endpoints can no longer publish a snapshot or create a database; blocked attempts are
  counted, logged and surfaced to administrators.
- Found and fixed five read paths that wrote: `CREATE TABLE IF NOT EXISTS` in `/api/bank`,
  `/api/tally-mapping`, `/api/tally-export`, `/api/transfers` GETs, and audit/idempotency rows for
  the `/api/tds-check` calculation check.
- Measured effect on a 3 MB file: warm write 19.0/38.6 KB → 0.6/27.0 KB; fresh-instance write
  19.0/331.6 KB → 0.6/32.5 KB. One session on a cold instance: 304.4 KB down, 113.2 KB up.
- Identical concurrent reads are coalesced into one hydration, keyed by organization, environment,
  user, role, permissions and If-None-Match.
- Diagnostics add per-endpoint access class, database reads/writes, blocked uploads, monthly budget
  with alerts at 50/75/90/100% of `SOLIVY_TRANSFER_BUDGET_GB`, and spike attribution.
- 9 new online regression tests (102 tests in total).

## 2.7.1 — 2026-10-30 (API & transfer optimisation)
Details in `RELEASE-NOTES-v2.7.1.md`; measurements in `docs/PERFORMANCE-v2.7.1.md`. No financial
logic, report calculation, template or layout changed.
- One session on a cold instance: database transfer 3,397 KB → 299 KB down, 506 KB → 73 KB up
  (measured on PostgreSQL 16, not Neon).
- Public sign-in screen reads a derived projection row instead of hydrating admin.db (801 KB → 0.4 KB).
- `/api/companies`, group MIS and group reports hydrate only what they use, not every organization.
- ETag/304 on `/api/data`, `/api/reports` and the reference endpoints, with a shared deduplicating,
  abortable client request layer; repeat screens transfer ~0.4 KB instead of their payload.
- Reports tab loads the legacy MIS tables only when that view is opened (634 KB → 8.9 KB).
- Snapshots: 4 KiB page-aligned chunks, Brotli, whole-file base blob, compressed manifest — a single
  posting uploads 5.9 KB instead of 406.7 KB.
- Synchronisation journal trimmed for databases nothing pulls from (49% of an organization file).
- Background sync paced by window visibility; dashboard duplicate fetch removed.
- New administrator screen and API: application-measured API and database transfer diagnostics.

## 2.7.0-rc.1 — 2026-10-29
Release candidate over v2.6.30. Details are in `RELEASE-NOTES-v2.7.0-rc.1.md` and the gate status in `RELEASE-STATUS.md`.
- Online storage: delta, chunked, atomic, locked and versioned. Network transfer per request fell from MB to KB (measured on PG16).
- `/api/data` is read-only and loads per module. Repairs on read became admin dry-run/confirm actions.
- Security: header stripping, session revocation, shared login throttle, license gate fixes, audit diffs.
- Sync: acknowledgement-based pruning and 410; financial conflicts block.
- Accounting: derived double-entry journal, statements, and 33 reports with exports, drill-down, budgets and groups.
- Documents: 5 templates, preferences and preview; the moisture/quality double-count is fixed; Truck No. follows Sample No.; reversed payments are blocked.
- Operations: online snapshot tool (backup, restore, rollback) and the operations guide.
- Tests: 60 offline, 17 online, 4 UI, plus all legacy `check-*` scripts.
