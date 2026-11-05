# SOLIVY Finance — Architecture (v2.8.0)

## Stack
Next.js 15 App Router + React 19, a single page `app/page.tsx` with components in `app/components/`, and API routes in `app/api/**`. Storage is **SQLite** through better-sqlite3. Documents are built with jsPDF, and spreadsheets with xlsx.

## Storage
- **Offline:** `FINANCE_DATA_DIR` contains `admin.db` (users, organizations, sessions, audit, login attempts) plus one file per organization per environment (LIVE/TEST).
- **Online:** the same SQLite files are stored in PostgreSQL or Neon (`lib/postgres-sqlite-bridge.ts`, `lib/snapshot-store.ts`).
  - Each file is split into content-hashed **4 KiB** chunks — one SQLite page — compressed with Brotli, plus a whole-file **base blob** for instances holding no copy. A request hydrates only its scope (`admin`, `company`, `company-both`, `all-mode`, `all`, or exactly the files a route declares through `extraFiles`).
  - A warm instance makes one version check per request and downloads only changed chunks, verified by SHA-256; a cold instance takes the base blob plus the chunks that changed after it.
  - Writes upload only the pages SQLite dirtied, in **one PG transaction**, under per-organization advisory locks, with optimistic versioning (409 on conflict). The base blob is rebuilt once 20% of chunks diverge.
  - The chunk manifest is stored compressed and is not fetched on the write path.
  - A tiny derived projection (`lib/public-projection.ts`) serves the public sign-in screen so it never hydrates `admin.db`.
  - The synchronisation journal of a database nothing pulls from is trimmed after a successful write (`lib/sync-prune.ts`); the audit trail is never touched.
  - Admin-writing routes take the `admin` lock first, and an in-process mutex serialises requests.
- **Schema:** controlled by `PRAGMA user_version` (`SCHEMA_VERSION=27`, `lib/db.ts`). There is a pre-migration backup, and migrations are additive. Sync triggers are rebuilt only when the schema changes, and reopening an unchanged file leaves it byte-identical.

## Declared database access (v2.7.2)
`lib/api-access.ts` is the single declaration of READ / WRITE / NO_DB for every route and method.
The bridge reads it per request: NO_DB never connects, READ can never publish a snapshot (only a
schema upgrade of a file it had to open), WRITE persists only changed pages. Blocked attempts are
counted in `bridgeGuardStats()` and reported to administrators. `scripts/check-api-access.cjs`
fails the build when a declaration is missing, extra or contradicted by the code. Identical
concurrent READ requests are coalesced per instance, keyed by organization, environment, user,
role, permissions and `If-None-Match`.

## Request pipeline
1. `middleware.ts` strips any client `x-aksh-*` headers, verifies the session cookie, injects the identity headers, and applies the RBAC rules in `lib/security.ts` and the license gate.
2. `withPostgresSQLiteBridge(handler, opts)` hydrates the scope, then `guardedHandler` (`lib/route-guard.ts`) runs:
   - session revocation (token `iat` versus `sessions_revoked_at`);
   - `Idempotency-Key` replay;
   - an audit entry with secrets redacted, plus a before/after diff for edits.
3. The handler runs, then the changed chunks are written back.

## Data API and caching
- `GET /api/data?modules=…` is read-only, and each tab loads only its modules (`TAB_MODULES` in `app/page.tsx`); the legacy MIS tables load only while that view is open.
- Conditional responses: `lib/data-version.ts` derives change watermarks (the synchronisation journal sequence, applied-event count, prune watermark and schema version for company data; counts, ids, audit id and revocation stamps for administration data) and turns them into a strong ETag together with the caller's organization, environment, permissions and requested modules. `/api/data`, `/api/reports` and the reference endpoints answer 304 when the client is current.
- `app/lib/client-http.ts` is the shared browser layer: concurrent identical GETs share one request, ETag-validated entries are kept per organization and environment, and a superseded request is aborted. Reuse always costs a revalidation round trip, so financial data is never read from a stale cache.
- `lib/transfer-metrics.ts` records per-request API and snapshot bytes, the declared access class, database reads and writes and blocked upload attempts into `solivy_transfer_metrics`. `lib/transfer-budget.ts` adds month-to-date usage against `SOLIVY_TRANSFER_BUDGET_GB` with once-per-month alerts at 50/75/90/100% (`solivy_transfer_alerts`) and per-endpoint spike attribution. `/api/admin/transfer-metrics` and the Administration panel report all of it, labelled as application-measured rather than provider-billed.
- Repairs that used to run on read are now explicit admin actions: `/api/admin/data-health` (GET is a dry run; POST requires `confirm:true`).

## Accounting (ADR-001)
- `lib/accounting/journal.ts` derives a balanced double-entry journal in integer paise from the operational tables, so source records stay authoritative. Unmatched rows go to Suspense and are listed as exceptions.
- `statements.ts` produces the trial balance, GL, P&L, balance sheet and cash flow.
- `operational.ts` produces AR/AP aging, sales, purchases, inventory, GST and the audit log.
- `registry.ts` is the catalogue of 33 reports plus reconciliation. `export.ts` handles CSV, XLSX and PDF.
- The API is `/api/reports`, `/api/reports/group` and `/api/budgets`; the UI is `app/components/ReportsHub.tsx`.

## Interface (v2.8.0)
`app/theme.css` holds every colour as a token, set per mode (`html[data-mode=light|dark]`) and per
accent (`html[data-accent=…]`); `app/lib/appearance.ts` applies and persists the choice, and
`app/components/ui.tsx` provides the theme control, loading skeletons and animated figures.
Navigation is declared once as `NAV_GROUPS` in `app/page.tsx` (Core Finance, Collection & Funding,
Purchases, Reconciliation & Reports, Administration & Sync) and rendered by both the sidebar and the
mobile drawer; screens left out of the groups still work and keep their routes.
`app/components/ProfilePanel.tsx` is the profile and settings module.

## Synchronisation conflicts (v2.8.0)
`lib/sync-delete.ts` resolves conflicts where a record is missing, deleted or recreated: it
classifies the conflict, refuses to delete POSTED financial records, lists dependent rows and only
removes them on confirmation, blocks a stale deletion from discarding a newer record, writes the
parent and every removed child to `sync_resolution_log` before deleting, and derives resolution ids
from the conflict so a retry applies once.

## Documents
- `lib/documents/bill-model.ts` is the one bill model:
  - deductions, including moisture/quality without double-counting;
  - Truck No. after Sample No.
- `templates.ts` holds the 5 renderers. `preferences.ts` stores preferences per user and per company.
- The routes are `/api/purchase-bill` (with `?preview=1`, `?template=`) and `/api/document-templates`. Reversed or non-posted entries are refused.

## Sync (offline ↔ online)
- Each SQLite file has a trigger-based change journal (`sync_changes`). Device tokens are scoped to one organization and one environment.
- Exchange is in `/api/sync/exchange` and `/api/sync/run`:
  - pruning is acknowledgement-based (`lib/sync-prune.ts`), and a pruned cursor gets 410;
  - financial tables block on conflict (`lib/sync-policy.ts`).
- v2.8.1: **events apply one at a time**, each in its own transaction, on both the hub and the
  device. A batch is never discarded as a whole; an item that cannot be applied is quarantined in
  `sync_rejects` with its table, record key, operation, reason and the run's correlation id, and is
  replayed from that stored event by `/api/sync/rejects` (not from the sync cursor). HTTP 409 means
  nothing in the batch could be applied. The push marks only accepted events, so a rejected item
  stays queued and retryable.
- Table eligibility is decided once, in `lib/sync-eligibility.ts`, for the hub, the device, the
  resolver and the trigger builder. Per-device bookkeeping (`LOCAL_ONLY`) queued by an older build
  is acknowledged and discarded as obsolete; anything else unapplicable is quarantined by name.
- v2.8.3: foreign-key dependencies are resolved in `lib/sync-fk.ts` from the live schema in both
  directions. A DELETE is blocked by the rows that reference the record, so that is what its conflict
  names (table, column, record ids), including columns that reference by convention without a foreign
  key. The device-side apply runs the same posted/stale/reference guards as the hub, and a record
  whose deletion is blocked by history can be deactivated instead (`active=0`, journalled so both
  devices agree) rather than deleted.
- An absent record resolves deterministically per operation (`lib/sync-absent.ts`): an already-done
  deletion is a no-op, a never-received record is restored, and an edit against a record deliberately
  deleted here is kept in the quarantine rather than resurrecting it.

## Clone engine (v2.9.0)
- The online side stores the whole organisation SQLite file in PostgreSQL (page-aligned chunks), so a
  full clone is a verified snapshot transfer while incremental sync stays event-based: a hybrid.
- `lib/clone-engine.ts` snapshots with `VACUUM INTO`, validates (integrity, foreign keys, schema
  version, accounting invariants), fingerprints every business table and 16 financial aggregates,
  stages to a separate key or temporary file, verifies the staged copy against the source, and only
  then activates — keeping the replaced copy for rollback.
- `lib/clone-store.ts` keeps upload chunks, the per-organisation clone lock and the run log in
  PostgreSQL, so transfers resume after an interruption or a restart and two clones cannot overlap.
- `/api/sync/clone` is the hub side (device-token auth, like exchange); `/api/sync/clone/run` is the
  device side and drives both directions, requiring an administrator and a typed confirmation.
- Each side keeps its own `sync_meta` identity across a clone; `realignAfterClone` settles the
  journal and sets the cursor to the snapshot's high-water mark so incremental sync continues.

## Payment advice, moisture and the quality deduction (v2.12.1)
- `lib/utils.ts purchaseCalc` is the only calculation. It has **no moisture threshold and no
  per-excess-percentage rate**: a quality deduction comes from `quality_deduct_rate_per_kg`
  (rate × rate, and then nothing is deducted for moisture) or `quality_deduct_per_mt`
  (net_weight/1000 × rate, with the `moisture` field's value deducted as rupees alongside it).
- `lib/documents/moisture.ts` decides how a stored moisture figure is *presented*;
  `lib/documents/advice-model.ts` (v2.12.1) and `lib/documents/bill-model.ts` apply the same
  deduction rule, so the advice and all five bill templates print the same rows from one purchase.
  Under the per-kg rule the quality deduction is the moisture deduction and appears once.
- The advice's layout is the one it has always had (v2.12.2): the moisture percentage rides in the
  existing "Less: Moisture Deduction (…)" row's label, and the row order is unload, freight,
  moisture, discount, rokdi, quality, other. The model reports, and never adjusts, a disagreement
  between the rows and the stored `total_deduction`; it is not printed.
- `bill-model.ts` also offers a **Bags** column on the commercial and third-party bills
  (`show_bags`, off by default), printing the purchase's `bags_qty` after HSN and before Quantity.

## GRN to draft purchase (v2.10.0, tool-independent since v2.10.2)
- `lib/grn/pdf-native.ts` reads the PDF in plain JavaScript with Node's `zlib` alone — no tool, no
  dependency, nothing executed or fetched. It gives the real page count from the page tree, the
  text layer decoded from the content streams (`Tj`/`TJ`/`'`/`"`, `/ObjStm` objects included), and
  the page images out of the file: a `/DCTDecode` page is already a JPEG, an 8-bit `/FlateDecode`
  DeviceRGB/Gray page is re-wrapped as a PNG.
- `lib/grn/ocr-wasm.ts` is the OCR engine that **ships with SOLIVY** (v2.11.0):
  `vendor/tesseract-wasm/` holds a WebAssembly build of Tesseract and `eng.traineddata`
  (Apache-2.0; provenance, checksums and notices in that folder's `NOTICE.md`). It is loaded by a
  path resolved from the module's own location — never the working directory, never `PATH` — the
  language data is written into the engine's in-memory filesystem, and the engine is created once
  per process. Recognition is local: no network call of any kind, so it works offline and costs no
  API calls or Neon transfer. `SOLIVY_GRN_OCR_WASM_DIR`, `SOLIVY_GRN_OCR_ENGINE`,
  `SOLIVY_GRN_OCR_LANG`, `SOLIVY_GRN_OCR_PSM` and `SOLIVY_GRN_OCR_BUDGET_MS` override the defaults
  for advanced use; nothing needs configuring.
- The engine module is loaded by `loadFactory` (v2.11.2) through five guarded routes — static
  `createRequire`, a run-time `import('node:module')`, the module's own `require`, `require` via
  `eval`, and `import('file://…')` of the engine file — because a Next.js server bundle can leave
  the named import from `node:module` undefined, which made every page fail with
  `undefined is not a function`. Each route is tested on its own,
  `SOLIVY_GRN_OCR_LOAD_ROUTES` can pin one, the engine's own methods are checked before use, and a
  failure names every attempt. `GET /api/grn?selftest=1` loads the engine and reports the route,
  version and language data, or the attempts and why each failed.
- `lib/grn/multi.ts` (v2.12.0) reads a whole upload rather than its first GRN: it classifies every
  page, takes **every** data row of a consignment list as its own GRN (stable id from page and
  printed position, all eleven columns, the Total row excluded and used as a cross-check against
  the summed rows), reads each bill's goods lines from the column order that bill prints, links
  bills to rows on corroborating evidence with ties reported, and presents one row at a time to the
  existing `buildDraft`/`purchaseCalc` through `asParsedDocument`. Nothing ambiguous is placed: a
  row or line with more figures than columns leaves the uncertain cells empty, and a rate that was
  not printed is never derived from the amount (`calculated_check` carries that figure instead).
  `bestBill` runs both the column-driven and the layout-specific bill parser so a new layout cannot
  degrade one that already worked.
- `lib/grn/regions.ts` (v2.11.1) locates the parts of a scanned page worth reading a second time,
  from the label words the first pass found — never from pixel coordinates — and rebuilds a table
  row by column so a cell the document printed wrapped arrives whole. The rebuild is validated per
  column and discarded entirely if a cell does not fit. `recognisePage` reads a region with
  `SetRectangle` on the image already loaded. The pass is gated (it runs only when the first pass
  left a required field unread, judged by the real parser) and guarded (kept only when coverage
  strictly improves), so it can add a missing cell but never degrade a page.
- `lib/grn/extract.ts` builds on it and treats external tools as optional accelerators:
  `pdftotext -layout` is preferred for a text layer where installed, `pdftoppm` renders a
  vector-only page, and `tesseract` alone recognises a scan (it is handed the page's own embedded
  image, with the resolution computed from the page geometry). Tools are looked up by the
  `SOLIVY_PDFTOTEXT` / `SOLIVY_PDFTOPPM` / `SOLIVY_TESSERACT` overrides, the PATH, and the usual
  Windows install folders. With nothing installed, a text-layer PDF still imports exactly and a
  scan is recognised by the bundled engine. Each page carries its own diagnostic (status, engine,
  duration, characters, confidence) and recognition is bounded in time; a page it cannot read is
  marked `failed` or `not-attempted`, never assumed read. Manual entry (`manual_entry` in the
  response: a complete but empty draft, nothing proposed) remains the last resort for a machine
  where no engine can be used at all. A page counts as recognised only when `lib/grn/parse.ts`
  finds its fields — never because OCR returned characters.
- `lib/grn/parse.ts` reads a GRN page and a party bill into fields with confidences; `lib/grn/draft.ts`
  maps them onto the purchase form, matches the party, finds duplicates and prices the draft with
  `lib/utils.ts purchaseCalc`.
- `lib/grn/contract.ts` normalises every `/api/grn` response into one shape (always a draft, a numeric
  purchase and a calculation) so a failed or partial extraction renders as a failure instead of
  crashing; `app/components/GrnImportWizard.tsx` is the wizard the Add Purchase modal opens.
- `/api/grn` stores the document and returns the proposal; the purchase itself is created by the
  existing `/api/purchases` from the values confirmed on `/grn`. `grn_documents` carries the audit
  record and synchronises; `grn_document_files` holds the optional original and does not.

## Tests
`tests/` contains unit, integration (SQLite), online (real PostgreSQL), ui (Playwright) and bench suites. Commands are in `docs/OPERATIONS.md` §9.
