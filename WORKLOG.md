# Worklog

## 2026-10-30 — v2.8.0 (SaaS redesign + sync fix)
**Baseline:** v2.7.3. The request named v2.7.5, which does not exist in this repository.

**Root causes found:**
- The "missing/deleted record" message pointed at a resolution that was never implemented. Worse,
  `applyEvent` deleted a row whenever it existed, so a stale deletion could silently remove newer
  financial data, and a resolution was journalled as originating from the device that *applied* it,
  so it echoed back to the peer and re-conflicted — the queue could never be drained. Found by
  writing a test that drains conflicts in a loop.
- The register/form mismatch is `discount_after_quality`: read from company settings at save time by
  the server, and re-read live by the form. Change the setting and the two disagree by exactly
  quality × discount% (₹1,042 on the reported bill). Fixed by recording the rule with the record and
  deriving it for legacy rows from the stored total; nothing is recalculated.
- `sync_resolution_log` was being synchronised and its before-images could exceed the body limit.

**Decisions:** posted financial records are never deleted by a resolution (reversal only);
deletions with dependents need explicit confirmation and keep a recovery copy; unreproducible
register rows are flagged rather than corrected automatically; the redesign is token-driven CSS so
every existing screen follows without rewriting markup.

**Evidence:** `docs/verification/test-run-2026-10-30-v2.8.0.txt`, `docs/ui/v280-*.png`.

## 2026-10-30 — v2.7.3 (moisture display)
The stored `purchases.moisture` column means two things depending on the quality rule, and the
purchase form labels it "Moisture (%)": under the rate-per-kg rule `purchaseCalc` deducts nothing
for it (the quality deduction is the moisture money), under the legacy per-MT rule it deducts the
stored value itself. Displays that printed the raw column as currency were the bug. One helper now
decides the presentation everywhere; the money shown is always the amount the calculation applied,
and a value above 100 is treated as a legacy rupee amount rather than claimed as a percentage.
Sites fixed: shared bill model (all templates/PDF/preview), payment advice, Purchase/Sample KPIs,
document-settings labels, purchases export.

## 2026-10-30 — v2.7.2 (NEON GUARD)
**What the access classes found.** Declaring READ/WRITE/NO_DB per route and enforcing it in the
bridge immediately caught five read paths that were writing: `CREATE TABLE IF NOT EXISTS` on the
GET paths of `/api/bank`, `/api/tally-mapping`, `/api/tally-export` and `/api/transfers`, and
audit + idempotency rows for the `POST /api/tds-check` calculation check. Each published a new
snapshot version, which forced the next write to re-materialise the file (19 KB manifest read) and
eventually rebuild the whole-file base blob (331 KB upload). That was the explanation for the two
write regressions measured in v2.7.1 on 3 MB files; both are now 0.6 KB read and 27-32 KB written.

**Decisions:**
- The registry, not the call site, is the source of truth for access class, so a route cannot widen
  its own access.
- A READ route may still persist a schema upgrade of a file it had to open; anything else is
  blocked, counted and logged rather than silently dropped.
- Reads never create a database: an unused environment is reported as empty.
- Budget alerts are recorded per month and threshold so multiple instances do not repeat them.
- Spike detection compares an endpoint against its own median, not against other endpoints.

**Not done:** inferring access classes from code (declared + audited instead); cross-instance read
coalescing (per instance only); Neon measurement (no Neon project available).

**Evidence:** `docs/PERFORMANCE-v2.7.2.md`, `docs/verification/test-run-2026-10-30-v2.7.2.txt`,
`docs/bench/client-after-v2.7.2.json`, `docs/bench/after-v2.7.2.json`.

## 2026-10-30 — v2.7.1 (API & Neon transfer optimisation)
**Measured first, then changed.** New harnesses: `tests/bench/client-bench.ts` (real UI in Chromium
against the real API, per-step request/response/PG byte accounting, two passes — upgrade and steady
state), `write-cost.ts`, `response-size.ts`. Baseline kept at `docs/bench/client-before-v2.7.0.json`.

**Facts found by measuring:**
- The public sign-in screen hydrated `admin.db`: 801 KB of Neon transfer per visit, authenticated or not.
- `GET /api/companies` was declared `scope:'all'` — it hydrated every organization's LIVE and TEST
  file to read names out of `admin.db`. This dominated sign-in (2.57 MB).
- `sync_changes` was 932 KB of a 1.9 MB organization file (49%), inflating every hydration.
- A single party write dirties 6 SQLite pages; at 16 KiB chunks that cost 406.7 KB of upload.
- The dashboard fired `/api/group-mis` three times per mount, twice for the wrong organization.
- Whole-file Brotli beats per-chunk gzip 2:1, which is why the base blob exists.
- `/api/data` payloads compress ~23:1, and all but 7 columns of the large tables are read somewhere
  in the UI — so field trimming and pagination were rejected as risk without reward.

**Decisions:**
- Caching is conditional only: nothing is reused without a server 304. No TTL on financial data.
- Journal trimming applies only to databases with no upstream pairing and no active paired device,
  and records a watermark so a device paired later re-baselines. Audit logs are never pruned.
- Transfer diagnostics are labelled application-measured; the provider dashboard stays the bill.

**Not done, deliberately:** `/api/data` row pagination and field projection (see above), server-side
TTL caches (the conditional responses already remove the transfer, and a TTL would risk staleness).

**Evidence:** `docs/PERFORMANCE-v2.7.1.md`, `docs/verification/test-run-2026-10-30.txt`,
`docs/bench/*.json`.

## 2026-10-29 — v2.7.0-rc.1 (branch rc/v2.7.0, baseline 369b063 = v2.6.30)
**Done:** workstreams A–H. See CHANGELOG and RELEASE-STATUS.

**Facts discovered:**
- The online mode stores the SQLite files inside PostgreSQL. v2.6.30 downloaded and uploaded every file on every request: about 12 MB read and 6.5 MB written per request with 3 organizations.
- pg-protocol 1.10.3 corrupts binary bytea, so data moves as base64.
- `/api/data` used to write: it ran the TDS repair and the party mirror on every read.
- Bills were renumbered on open.

**Decisions:**
- ADR-001: a derived journal, not a stored ledger.
- Financial sync conflicts are never auto-merged.
- No tax rules were changed.

**Environment limits:**
- No npm registry access (403), so there is no lockfile and Next.js was never installed.
- `next build` and `next lint` were not run. The typecheck uses stubbed Next types.
- Online tests ran against a local PG16 (127.0.0.1:54329), not Neon.

**Evidence:** `docs/verification/test-run-2026-10-29.txt` and `docs/bench/*.json`.

**Next:**
1. `npm install`, commit the lockfile, then build, lint and test on a real install.
2. Run the Neon branch tests and bench.
3. Run against a staging copy of the production data.
4. CA review of GST/TDS.
5. Replace or isolate xlsx for imports.
6. Nonce-based CSP.
7. Post inventory to the GL, and record purchase GST.

## 2026-10-31 — v2.8.1, P0 synchronization repair
**Found (traced, not guessed):** the hub, the device, the resolver and the trigger builder each kept
their own `excluded` table set with different memberships, and `tableInfo()` reported every
ineligibility with one message that named no table — the reported "Table is not eligible for
synchronization. · 409". Both apply paths ran the entire batch in one transaction, so one
unapplicable event rolled back all the others; the push then marked nothing as pushed and the pull
committed no cursor, so the identical batch was re-sent and failed identically forever. The
absent-record branch threw the same conflict for every operation, including a DELETE whose record
was already gone on both sides — the "records are null on both sides but the push still does not
sync" report.

**Done:** one shared eligibility rule (`lib/sync-eligibility.ts`); per-event apply with a quarantine
(`lib/sync-quarantine.ts`, `sync_rejects`, schema 29); a deterministic per-operation rule for an
absent record (`lib/sync-absent.ts`); `/api/sync/rejects` to list, retry (replayed from the stored
event) and deliberately stop retrying an item; correlation ids on every sync request with
identifier-only logging; the Sync screen lists set-aside items with Retry / Do not retry. Also fixed
a UTC/local month-length error in the transfer-budget projection.

**Tests:** 78 offline (real SQLite), 44 online (real PostgreSQL 16), 10 browser, 15 legacy scripts,
typecheck clean — `docs/verification/test-run-2026-10-31-v2.8.1.txt`. The 12-point sync gate is
mapped to named tests in `SYNC-REPAIR-v2.8.1.md`.

**Not verified:** Neon itself (local PG16 only), production build and lint (no npm registry), schema
29 against a copy of real production data.

**Next:** P1 — GRN PDF extraction to a draft purchase (the sample PDF is attached), only after this
gate is accepted.

## 2026-10-31 — v2.8.2, P0 API compatibility
**Found (root cause):** `app/api/data/route.ts` was missing from the v2.8.1 release ZIP I delivered.
The staging command used `tar --exclude=data`, which matches a directory of that name at any depth,
so `app/api/data/` was dropped with the runtime data directory. v2.7.1-v2.8.0 contain it; v2.8.1 lost
that one file and nothing else. Anything deployed from v2.8.1 therefore answers GET /api/data with
404. Excludes are now anchored, and `scripts/check-release-package.mjs` verifies an extracted package
against the checkout before delivery.

**Also found:** the source was never missing an API. Route inventory against
the v2.8.0 ZIP: 0 routes lost, 0 exported methods lost (68/110 -> 69/112, only `sync/rejects` added
in v2.8.1). `/api/data` exports GET and the literal request returns 200 in LIVE and TEST for an
authorised user of organisation 2, with organisation and environment isolation asserted. Middleware
has no rewrite and cannot emit 404, so a 404 means the route was absent from the running build.
Separately, the Docker runtime stage copied neither `scripts/` nor `next.config.mjs` while
`npm run start` executes `scripts/ensure-local-secret.cjs`, so that image could not start at all.

**Done:** fixed the Dockerfile; added `scripts/api-route-manifest.json` plus
`scripts/check-api-routes.cjs` (release gate, and runnable against an unpacked release),
`scripts/check-api-live.mjs` to probe a running deployment for 404s, and
`tests/integration/api-compat.test.ts` (route/method inventory, UI caller check, the reported
request, isolation). Moved `applyLocal` into `lib/sync-apply.ts` so no route imports another route.

**Tests:** 84 offline, 44 online (PG16), 10 browser, 16 scripts, typecheck clean —
`docs/verification/test-run-2026-10-31-v2.8.2.txt`.

**Not verified:** production build and lint (no npm registry), Neon, and the Dockerfile fix (reviewed,
not built). If a 404 was also seen on a build older than v2.8.1, that would have a different cause
and is not diagnosed.

**Next:** P2 — GRN PDF to a draft purchase, once the P0/P1 gate is accepted.

## 2026-10-31 — v2.8.3, party DELETE sync conflict
**Found:** two defects behind `parties · DELETE · id 15` / "Referenced tables not discoverable from
this table schema". (1) The device-side apply (`lib/sync-apply.ts`) deleted the row with no guard at
all, unlike the hub, so SQLite raised a bare FOREIGN KEY error. (2) `describeForeignKeyFailure` named
parents from `PRAGMA foreign_key_list(parties)` — the direction parties points at, which is empty —
instead of the 12 foreign-key columns in 11 tables that point at a party (purchases, payments,
ledger, money_in, money_out, financing_receivables, interest_payments, funding_loans, saudas x2,
bank_accounts, party_aliases). `dependentsOf` also swallowed probe errors and reported "no
dependents", which is how a blocked deletion reached the database.

**Done:** `lib/sync-fk.ts` resolves both directions from the live schema with blocking record ids and
reports undeclared conventional references; the device DELETE runs the posted, stale and reference
guards; `HAS_DEPENDENTS` names tables, columns and ids; `/api/sync/rejects {action:'deactivate'}`
preserves history by setting `active=0` as a journalled UPDATE, idempotently, on explicit request
only, with a "Deactivate instead" button on the Sync screen.

**Tests:** 90 offline, 46 online (PG16), 10 browser, 16 scripts, typecheck clean —
`docs/verification/test-run-2026-10-31-v2.8.3.txt`. New: `tests/integration/party-delete-refs.test.ts`
and two multi-device party-deletion tests in `tests/online/sync-e2e.test.ts`.

**Not verified:** the user's own party id 15 (no access to that database; the conflict will now name
its exact blockers), production build and lint, Neon.

**Next:** P2 — GRN PDF to a draft purchase.

## 2026-10-31 — v2.9.0, bidirectional sync and full database clone
**Found:** the architecture is a hybrid — the online side stores the whole organisation SQLite file
in PostgreSQL as page-aligned chunks (lib/snapshot-store.ts), while device <-> hub sync is event
replication over the sync_changes journal. Event replication cannot converge without a common
ancestor, which is why two drifted databases produced a conflict per record and resolving one
exposed the next. Also found and fixed while testing: activating a clone verbatim transfers the
sender's sync_meta, so the receiving side adopts the sender's device id and its own changes are then
filtered out by `origin_device <> me` — sync would have looked healthy and moved nothing.

**Done:** clone engine in both directions (snapshot via VACUUM INTO, validate, fingerprint with 16
financial aggregates, stage, read-back verification, activate with the replaced copy kept), durable
resumable 1 MiB chunked transfer with locks and run log in PostgreSQL, identity-preserving
realignment so incremental sync continues correctly, and a clone/health dashboard with preview,
typed confirmation, validation and online rollback.

**Tests:** 90 offline, 56 online (PG16; 10 new clone tests covering both directions, repeat clones,
incremental sync after a clone, interruption, restart, duplicate retry, partial batch, schema
mismatch, isolation, rollback, concurrent clones), 10 browser, 17 scripts, typecheck clean —
`docs/verification/test-run-2026-10-31-v2.9.0.txt`.

**Not verified:** Neon itself (local PG16 only), production build and lint, clones of
multi-hundred-megabyte databases, and merging two databases that each hold records the other needs
(a clone replaces the destination; use the kept copy to re-enter the few records).

**Next:** P2 — GRN PDF to a draft purchase.

## 2026-11-01 — v2.10.0, GRN document to draft purchase (P2)
**Inspected first:** the supplied PDF is a 2-page SCAN with no text layer. Page 1 is a Sayaji
"GRN List Report" (sample 2627-22603, 17.10.2026, truck 5630, 375 bags, 21262 kg net, moist 11.50%,
threshold 14%); page 2 is a Deepak Enterprises "Bill of Supply" (invoice 274, 13-Oct-26, vehicle
GJ04X5630, 375 pkgs Maize HSN 10059000, 218.90 qtl @ 2,000/qtl = 4,37,800, tax NIL). Two findings:
the rate is per QUINTAL, not per kg as the brief assumed, and the two pages differ on weight
(21,890 dispatched vs 21,262 received).

**Done:** local extraction (text layer, else poppler+tesseract at 300 dpi / psm 4, measured on this
scan; no new dependency, nothing leaves the machine), a parser written against the real recognition
output with per-field confidence, page linking on the vehicle-number tail, party matching
(GSTIN/name/alias) with party and bank drafts, duplicate detection, a draft priced by the existing
purchaseCalc, the /grn review screen, and `grn_documents` + local-only `grn_document_files`
(schema 30). The purchase is created only by the existing /api/purchases after confirmation.

**Tests:** 104 offline (2 reported NOT VERIFIED without the uncommitted sample), 14/14 with the real
PDF, 56 online (PG16), 10 browser, 18 scripts, typecheck clean —
`docs/verification/test-run-2026-11-01-v2.10.0.txt`.

**Not verified:** Neon, production build and lint; recognition on layouts other than these two;
multi-consignment GRNs and multi-line bills (first line only).

**Next:** P3 — purchase-linked payment obligation and Mark Paid.

## 2026-11-01 — v2.10.1, GRN import inside Add Purchase + crash fix
**Found:** the reported crash was a data-contract assumption, not a missing `?.`: `/api/grn` answers
a failed extraction with `{ok:false, error, extraction}` and NO draft, and the screen stored that
response then read `result.draft.calculation`.

**Done:** `lib/grn/contract.ts` normalises every response (always a draft, a numeric purchase, a
calculation; `complete:false` plus `problems[]` when something is missing) and both consumers use
it; `app/components/GrnImportWizard.tsx` runs the import inside the existing Add Purchase modal
(page count, GRN/bill page numbers, unrecognised pages, page image, per-field tick boxes with the
current form value beside the document value, live purchaseCalc, Use in Purchase Form); default
ticks only where the form is empty; the wizard never posts. Encrypted PDFs are named; the
text-layer threshold is 12 characters.

**Tests:** 112 offline, 14/14 with the real sample PDF, 16 browser (6 new Chromium tests on the
wizard: no-draft response, non-JSON response, full extraction, selective apply, live recalculation
with no posting, Cancel/Escape), 56 online (PG16), 18 scripts, typecheck clean —
`docs/verification/test-run-2026-11-01-v2.10.1.txt`.

**Not verified:** `next build` (no npm registry), GRN upload against Neon, and a manual Add Purchase
save driven through the modal in a browser (API and shell level only).

**Next:** P3 — purchase-linked payment obligation and Mark Paid.

## 2026-11-01 — v2.10.2, the GRN import with no tools installed

**Reported:** on the user's machine the wizard said "No text could be read from this PDF on this
machine", "0 pages", "20 page(s) carry no text layer", and named pdftotext, pdftoppm and tesseract
as missing.

**Found, by inspecting the supplied PDF rather than the error:** the file is a classic xref PDF with
no object streams, and each page is a single embedded JPEG (`/DCTDecode`, 2558x3777 and 2669x3720).
Nothing about reading it needed an external tool — v2.10.0 had simply delegated every step. Three
defects: total dependence on poppler/tesseract; a page count that fell back to the scan limit (the
"20"); and a 422 with no draft, leaving the screen nothing to show or type into.

**Done:** `lib/grn/pdf-native.ts`, a zero-dependency PDF reader (object/xref scan, `/ObjStm`, page
tree, content-stream text, `/DCTDecode` passthrough, `/FlateDecode` to PNG by hand) now primary in
`lib/grn/extract.ts`; poppler and tesseract demoted to optional accelerators; tesseract alone is
enough for a scan, with the resolution computed from the page geometry and passed as `--dpi`;
Windows tool discovery broadened beyond the PATH; and a document that cannot be read becomes a
manual entry (200, `manual_entry: true`, complete empty draft, pages served from a kept local copy)
instead of a dead end.

**Evidence:** `docs/verification/test-run-2026-11-01-v2.10.2.txt` — typecheck 0 errors; 129/129
offline; 56/56 online on PostgreSQL 16.15; 17/17 browser; 24/24 source check scripts. The 13 new
tests in `tests/integration/grn-native.test.ts` all run with the three tools forced absent. With
poppler absent and tesseract present the sample still yields sample 2627-22603, 21 262 kg, 375 bags,
moisture 11.5 %, invoice 274, total 437 800, vehicle GJ04X5630.

**Not verified:** `next build` (no npm registry), GRN upload against Neon, the `/ObjStm` path (no
producer here emits object streams). Recognising a scan still needs Tesseract; no OCR engine can be
bundled from this environment.

**Next:** P3 — purchase-linked payment obligation and Mark Paid.

## 2026-11-02 — v2.11.0, scanned GRNs recognised with nothing installed

**Asked for:** automatic OCR of scanned GRN/supplier-bill pages on a normal Windows installation —
no separate Tesseract install, no PATH edit, no environment variable, no manual retyping.

**Done:** bundled a WebAssembly build of Tesseract plus `eng.traineddata` in
`vendor/tesseract-wasm/` (Apache-2.0; provenance commits, SHA-256 checksums and every statically
linked component's licence recorded in that folder's NOTICE.md and licenses/).
`lib/grn/ocr-wasm.ts` loads it by a path resolved from the module's own location — never the working
directory, never PATH — and writes the language data into the engine's in-memory filesystem, so the
install location is irrelevant. `lib/grn/extract.ts` chooses it by default, hands it the page image
already embedded in the PDF (so Poppler is not involved), tells it the resolution computed from the
MediaBox, keeps a 180 s budget, and records per-page status/engine/duration/chars/confidence. The
wizard gained a "Show how this document was read" panel. Add Purchase → Save is still the only
accounting write path.

**Two defects found and fixed while testing:** the loader used
`new Function('p','return require(p)')`, whose body sees only global scope, so it threw
`require is not defined` under ESM and under the test runner — replaced with `createRequire`; and a
text-layer PDF was being told the OCR engine was missing even though no page needed recognition —
that note is now conditional on `needsOcr.length`. Two v2.10.2 tests whose premise ("no tools" means
manual entry) the bundled engine supersedes were updated to disable the bundled engine too, so the
manual-entry last resort is still covered.

**Evidence:** `docs/verification/test-run-2026-11-02-v2.11.0.txt` — typecheck 0 errors; 141/141
offline; 56/56 online on PostgreSQL 16.15; 20/20 browser; 24/24 source scripts; 12/12 bundled-OCR
tests with the installed tools removed. Measured: page 1 5 703 ms / conf 89 / 1 034 chars, page 2
7 981 ms / conf 70 / 1 461 chars, engine `bundled-wasm`, Tesseract 5.1.0-288-g2a9c1, tools found
none. Every acceptance field of the supplied sample is asserted, including 21 890 kg dispatched kept
separate from 21 262 kg received and no deduction at 11.50 % moisture.

**Not verified:** Windows development and a packaged Windows build — no Windows machine here, and
this repository has no Windows installer or packaging configuration to put the engine into (exact
PowerShell steps are in GRN-AUTOMATIC-OCR-v2.11.0.md section 6); `next build` (no npm registry);
Neon; an instrumented before/after byte measurement (recognition adds no request at all, which is
asserted, but no byte comparison was run).

**Next:** P3 — purchase-linked payment obligation and Mark Paid.

## 2026-11-02 — v2.11.1, the second OCR pass and the wrapped supplier cell

**Asked for:** fix GRN OCR on the supplied scan, on the grounds that whole-page OCR misses the
truck number, received weight and moisture, and that only an enlarged table crop reads the row.

**Checked first.** The attached file is byte-identical to the sample already in use (SHA-256
7a14c520…d663a0). Through the shipped pipeline with the bundled WASM engine and nothing installed,
the whole-page pass already returns the complete row —
`2627-22603 | 17.10.2026 | 5630 ENTERPRIS 375 21262 0 0 0 11.50 0.00` — and the parser reads every
one of those fields. The brief's measurement came from the system Tesseract on the extracted JPEGs;
this pipeline hands the engine the embedded image with the DPI computed from the page geometry,
which is why it differs. So the stated premise was not the defect, and I did not write a test
asserting the opposite of what the engine does.

**One real defect in that row:** `PO Supplier` is narrow, so `AKSH ENTERPRISE` is printed wrapped
and OCR returns `AKSH` / `ENTERPRIS` / `E` on three lines. The parser took the row fragment only
and reported `ENTERPRIS`. Now reassembled from the neighbouring lines, with a note that says so.

**Implemented the targeted pass anyway, with guards.** `lib/grn/regions.ts` locates regions from
the page's own label words (anchors, scale-invariant, none without the labels), `recognisePage`
reads them with `SetRectangle` on the already-loaded image, capped at 4 a page. Two safeguards came
out of measurement rather than design: the pass runs only when the first pass left a required field
unread (coverage judged by the real parser), and its text is kept only when coverage strictly
improves — because the band pass at PSM 6 read this document's table *worse* than the whole page.
The column rebuild that joins a wrapped cell is validated per column and discarded entirely if any
cell does not fit its column's shape.

**Evidence:** `docs/verification/test-run-2026-11-02-v2.11.1.txt` — typecheck 0 errors; 155/155
offline; 56/56 online on PostgreSQL 16.15; 20/20 browser; 24/24 source scripts; 76 GRN invariants.
14 new region tests, including the engine's region pass driven on a real rendered image.

**Not verified:** no document was found where the second pass changes the outcome — every page
rendered as low as 100 dpi was still fully covered by the first pass, so the mechanism is proven to
work (region read, words, confidence, validation) but not yet proven to rescue a real page; a
rotated page has no fixture; Windows and packaged Windows (no installer in this repository);
`next build` and `next lint` (no npm registry); Neon; an instrumented byte measurement. The real
PDF is deliberately NOT committed as a fixture — it carries a vendor's GSTIN, bank account, phone
and email, so it stays behind SOLIVY_GRN_SAMPLE_PDF with masked OCR text committed instead.

**Next:** P3 — purchase-linked payment obligation and Mark Paid.

## 2026-11-02 — v2.11.2, the OCR engine would not load on the user's installation

**Reported:** the wizard fell through to manual entry with
`Page 1 could not be recognised (undefined is not a function)` for both pages.

**Diagnosed from that message.** It is not OCR failing — the engine never loaded, so every page
threw the same type error. `createRequire`, imported from `node:module`, can come back undefined
once `lib/grn/ocr-wasm.ts` has been through the Next.js server bundler; `undefined(…)` is precisely
that error. Here, under the test runner, the import is intact, which is why every suite passed while
the installation failed. A Next.js build cannot be reproduced in this environment (no npm registry),
so the fix had to make the loader independent of which module system it lands in rather than chase
one bundler's behaviour.

**Done:** `loadFactory` tries five routes in order, each guarded by `typeof` — static
`createRequire`, `createRequire` from a run-time `import('node:module')`, the module's own `require`,
`require` via `eval`, and `import('file://…')` of the engine file. Each route is proven on its own
in a test via `SOLIVY_GRN_OCR_LOAD_ROUTES` (all five load the engine here), which doubles as a way to
pin an odd build to a working route. The engine's own methods are checked before use, a module of the
wrong shape is reported rather than called, and a total failure names every attempt instead of
surfacing a type error. Added `GET /api/grn?selftest=1` so a machine can be checked without a
document. Two further faults fixed: a cached engine was reused after the configured folder changed
(it is now tied to its folder, and the self-test reads disk), and the party warning printed the
placeholder "the seller" as though it were a name.

**Evidence:** `docs/verification/test-run-2026-11-02-v2.11.2.txt` — typecheck 0 errors; 164/164
offline; 56/56 online on PostgreSQL 16.15; 20/20 browser; 24/24 source scripts; 86 GRN invariants;
9 new loader tests.

**Not verified:** that this fixes the user's installation — it cannot be reproduced here; the
self-test output from their machine is what will confirm it. Also `next build` and `next lint` (no
npm registry), Windows and packaged Windows, Neon, and an instrumented byte measurement.

**Next:** the user's `?selftest=1` output, then either the Windows installer or P3 (purchase-linked
payment obligation and Mark Paid).

## 2026-11-02 — v2.12.0, the whole document: many GRNs, many pages

**Asked for:** extract every GRN row and every supplier-bill line across the supplied 13-page
S M CORPORATION PDF, not just the first of each.

**Found by reading it first.** 13 scanned pages, one JPEG each, no text layer. Page 1 is a Sayaji
consignment list with **twelve** rows before the Total; pages 2–13 are eleven supplier bills from
three suppliers plus a Devanagari handwritten slip. The old pipeline read row 1 and bill 1.

**Done:** `lib/grn/multi.ts` — page classification (fuzzy, because these scans read "Bill of Supply"
as "Billof suenly"), multi-row list parsing with per-row identity and all eleven columns, a totals
cross-check that sums the rows against the printed Total, goods-line reading driven by the column
order printed on each bill, and evidence-based linking with ties reported. Each row becomes a draft
through the existing `buildDraft`/`purchaseCalc`; nothing is recalculated here. The API returns
`grns[]`, `documents[]`, `matches[]`, `page_classifications[]`, `totals` and `counts`, and the
wizard lists every consignment and takes them one at a time.

**Three judgement calls worth recording.** (1) Where a row or a goods line reads more figures than
the page prints columns, nothing ambiguous is placed — a wrong number in a financial field is worse
than an empty one; the figures read are listed instead. (2) A rate is never derived from
amount ÷ quantity; that figure is offered as `calculated_check` only. (3) The new column-driven bill
parser was *weaker* than the existing Tally-specific one on the old sample and broke a passing test,
so `bestBill` runs both and the specific one fills what the generic leaves empty.

**Evidence:** `docs/verification/test-run-2026-11-02-v2.12.0.txt` — typecheck 0 errors; 178/178
offline; 56/56 online on PostgreSQL 16.15; 22/22 browser; 24/24 source scripts; 100 GRN invariants.
Against the real document: 13 pages classified, 12 rows detected and 12 extracted, 11 bills, 10
goods lines, totals disagreeing on four columns (reported, not corrected), and 0 purchases,
0 payments and 0 parties after the upload.

**Not verified:** rotated pages, several list pages in one upload, a GRN spanning pages,
many-bills-to-one-row — no fixture has them. Six of the eleven bills on this document could not be
linked (four print no readable vehicle number) and four gave no usable goods line; both are shown
rather than guessed. Manual attach/detach controls are not built. `next build`, `next lint`,
Windows, Neon and a byte measurement remain unverified. The 13-page PDF is deliberately not
committed: three suppliers' GSTINs, bank accounts, PANs and contacts. Masked OCR fixtures are.

**Next:** manual bill-to-row attach/detach, or P3 (purchase-linked payment obligation and Mark Paid).
