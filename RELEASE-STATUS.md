# SOLIVY Finance v2.12.0 — Release verification report

**Status: RELEASE CANDIDATE — NOT PRODUCTION-READY.** v2.12.0 reads a whole upload instead of its
first GRN: every data row of a consignment list is its own GRN with its own draft, every page is
classified and kept, every bill's goods lines are read from the column order it prints, the printed
total is a cross-check against the summed rows, and bills are linked to rows only on corroborating
evidence (`GRN-MULTI-DOCUMENT-v2.12.0.md`, evidence
`docs/verification/test-run-2026-11-02-v2.12.0.txt`: typecheck clean, 178 offline, 56 online on
PostgreSQL 16.15, 22 browser, 24/24 source checks, 100 GRN invariants). Against the supplied
13-page document: 13 pages classified, 12 of 12 rows extracted, 11 bills, 10 goods lines, and no
accounting record created. **Six bills could not be linked and four gave no usable goods line** —
both shown rather than guessed. v2.11.2 fixes the reported
`undefined is not a function` on every page: the OCR engine never loaded, because a Next.js server
bundle can leave `createRequire` undefined. The engine file is now loaded through five guarded
routes, each proven independently, the engine's own methods are checked before use, a failure names
every attempt, and `GET /api/grn?selftest=1` reports a machine's engine without uploading anything
(`GRN-OCR-LOADER-FIX-v2.11.2.md`, evidence
`docs/verification/test-run-2026-11-02-v2.11.2.txt`: typecheck clean, 164 offline, 56 online on
PostgreSQL 16.15, 20 browser, 24/24 source checks, 86 GRN invariants). **That it fixes the reporting
installation is NOT VERIFIED** — a Next.js build cannot be reproduced in this environment; the
self-test output from that machine is what will confirm it. v2.11.1 adds a targeted second OCR pass,
located from the page's own label words, gated on the first pass leaving a required field unread and
kept only when it covers more; and fixes a supplier name the document prints wrapped
(`ENTERPRIS` → `AKSH ENTERPRISE`). The reported diagnosis — that whole-page OCR misses the truck
number, weight and moisture — did not reproduce on the shipped pipeline; see section 1 of
`GRN-REGION-OCR-v2.11.1.md` (evidence `docs/verification/test-run-2026-11-02-v2.11.1.txt`:
typecheck clean, 155 offline, 56 online on PostgreSQL 16.15, 20 browser, 24/24 source checks, 76 GRN
invariants). **No document was found where the second pass changes the outcome**, so its value is
proven mechanically rather than on a failing page. v2.11.0 bundles a WebAssembly Tesseract with
SOLIVY, so a scanned GRN is recognised automatically with nothing installed — no Tesseract, no
Poppler, no PATH entry, no environment variable, no internet, and no document leaving the machine
(`GRN-AUTOMATIC-OCR-v2.11.0.md`, licences `vendor/tesseract-wasm/NOTICE.md`, evidence
`docs/verification/test-run-2026-11-02-v2.11.0.txt`: typecheck clean, 141 offline, 56 online on
PostgreSQL 16.15, 20 browser, 24/24 source checks, 12/12 bundled-OCR tests with the installed tools
removed; both pages of the supplied sample recognised, every acceptance field asserted). **Windows
development and a packaged Windows build are NOT VERIFIED** — no Windows machine was available and
this repository has no Windows installer to extend; PowerShell verification steps are in section 6
of that document. v2.10.2 makes the GRN import work on a machine
with no poppler and no tesseract installed: the PDF is read in plain JavaScript (real page count,
text layer, page images), recognition needs tesseract alone, an installed tool off the PATH is
found, and a document that cannot be read becomes a manual entry against its own pages instead of a
refusal (`GRN-NO-TOOLS-v2.10.2.md`, evidence
`docs/verification/test-run-2026-11-01-v2.10.2.txt`: typecheck clean, 129 offline, 56 online on
PostgreSQL 16.15, 17 browser, 24/24 source checks). v2.10.1 moves the GRN import into the Add
Purchase modal and fixes the `draft.calculation` crash at the API contract
(`GRN-IMPORT-MODAL-v2.10.1.md`, evidence `docs/verification/test-run-2026-11-01-v2.10.1.txt`).
v2.10.0 adds GRN document → draft purchase
(`GRN-TO-PURCHASE-v2.10.0.md`, evidence `docs/verification/test-run-2026-11-01-v2.10.0.txt`: 104
offline, 14/14 with the real sample PDF, 56 online on PostgreSQL 16, 10 browser, 18 legacy scripts,
typecheck clean). v2.9.0 adds the full database clone engine in
both directions with staged, verified, rollback-able activation and a clone/health dashboard
(`CLONE-AND-SYNC-ARCHITECTURE-v2.9.0.md`, evidence
`docs/verification/test-run-2026-10-31-v2.9.0.txt`: 90 offline, 56 online on PostgreSQL 16, 10
browser, 17 legacy scripts, typecheck clean). v2.8.3 fixes the party DELETE sync conflict
(`PARTY-DELETE-SYNC-v2.8.3.md`, evidence `docs/verification/test-run-2026-10-31-v2.8.3.txt`: 90
offline, 46 online on PostgreSQL 16, 10 browser, 16 legacy scripts, typecheck clean). v2.8.2 adds the API-surface guard and fixes
the Docker packaging defect, and identifies the reported `/api/data` 404: `app/api/data/route.ts` was
missing from the v2.8.1 ZIP (anchored excludes and a package guard now prevent that; replace any
deployment built from v2.8.1). See
`API-COMPATIBILITY-v2.8.2.md` and `docs/verification/test-run-2026-10-31-v2.8.2.txt`: 84 offline,
44 online on PostgreSQL 16, 10 browser, 16 legacy scripts, typecheck clean). v2.8.1 repairs P1
synchronization; see
`SYNC-REPAIR-v2.8.1.md` and `docs/verification/test-run-2026-10-31-v2.8.1.txt` (Node v22.23.4,
2026-10-31): 78 offline, 44 online on PostgreSQL 16, 10 browser, 15 legacy scripts, typecheck clean.
 The same gates that blocked v2.7.0-rc.1 are
still blocked: the build environment cannot reach the npm registry, so there is no lockfile and
Next.js itself was never installed or built; and no Neon project was available, so the online
figures come from a local PostgreSQL 16. Test evidence: `docs/verification/test-run-2026-10-30.txt`
(Node v22.23.4, 2026-10-30) and `docs/verification/test-run-2026-10-30-v2.7.2.txt`. Transfer
measurements: `docs/PERFORMANCE-v2.7.2.md` (v2.7.2 vs v2.7.1) and `docs/PERFORMANCE-v2.7.1.md`.

## Gates

| # | Gate | Result | Evidence / reason |
|---|------|--------|-------------------|
| 1 | `npm ci` from a clean checkout with a committed lockfile | **NOT VERIFIED** | The npm registry is denied (HTTP 403) here. There is **no `package-lock.json`**; versions are pinned in `package.json`. Run `npm install` once with registry access and commit the lockfile. |
| 2 | `next build` (production build) | **NOT VERIFIED** | Next.js 15.5.27 could not be installed. Routes and components are exercised through a `next/server` shim and an esbuild bundle, not by the framework. |
| 3 | `next lint` | **NOT VERIFIED** | Depends on Next.js/ESLint, which could not be installed. |
| 4 | TypeScript typecheck | **PASS (qualified)** | `tsc --noEmit -p tsconfig.verify.json`: exit 0, 0 errors. Uses stub declarations for `next/*`, so it does not check against the real Next types. |
| 5 | Unit and integration tests (offline/SQLite) | **PASS** | `npm test`: **104 tests, 102 pass, 0 fail** (2 report NOT VERIFIED without the uncommitted sample GRN; run with `SOLIVY_GRN_SAMPLE_PDF` they pass) (adds the v2.8.1 eligibility, absent-record and quarantine tests). |
| 6 | Online tests (PostgreSQL bridge) | **PASS on PostgreSQL 16 / NOT VERIFIED on Neon** | `npm run test:online`: **56/56** (adds 10 clone tests) against a local PostgreSQL 16, including the 9 NEON GUARD tests and 5 sync delete/recreate tests. Covers multi-instance concurrency, delta chunks, the 4 KiB page-aligned format, the base blob, corruption fallback, the login projection, metrics, idempotency, sync end-to-end, backup/restore/rollback. Neon specifics (pooler, TLS, latency, billing meter) untested. |
| 7 | Browser UI test | **PASS (structure, theming, mobile metrics, GRN wizard)** | `npm run test:ui`: **16/16** (Playwright Chromium), covering the regrouped navigation, light/dark/accent themes and their persistence, the profile module, and mobile layout at 390×844. The UI is an esbuild bundle with the hand-written CSS linked; **Tailwind utility classes are not compiled there**, so final compiled appearance is NOT VERIFIED. Screenshots: `docs/ui/v280-*.png`. |
| 7a | Sync: delete/recreate conflicts, per-item rejection, quarantine retry, absent-record rule, cursor progress | **PASS on PostgreSQL 16** (12-point gate mapped in `SYNC-REPAIR-v2.8.1.md`) | `tests/online/sync-e2e.test.ts`: a deletion pushes to the hub; dependents refuse then apply on confirmation; a POSTED record is never deleted; a stale deletion cannot discard a newer record; retries create no duplicates; the conflict queue drains. |
| 7b | Purchase register equals the purchase form | **PASS** | `tests/integration/register-parity.test.ts`: the defect is reproduced (difference = quality × discount%), the rule is recorded with new records and derived for legacy ones, unreproducible rows are flagged, and stored figures are asserted unchanged. |
| 8 | Legacy regression scripts (`scripts/check-*`) | **PASS** | All 18 `scripts/check-*.cjs` exit 0, now including `check-api-routes.cjs` (69 routes, 112 exported methods, nothing lost against the v2.8.0 baseline), including `check-api-access.cjs`. Two had become stale against v2.8.0's redesign and v2.8.1's per-item conflict reporting and were re-pointed at the current mechanism (same property asserted): `check-finance-mis.cjs` theme persistence, `check-user-org-conflicts.cjs` conflict detail. |
| 9 | Transfer reduction measured before/after | **PASS on local PostgreSQL (measured) / NOT VERIFIED on Neon** | Per-workflow byte accounting in `docs/PERFORMANCE-v2.7.1.md` from `docs/bench/client-before-v2.7.0.json` vs `client-after-v2.7.1.json`, plus `after-v2.7.0.json` vs `after-v2.7.1.json`. Neon's own data-transfer meter was not read. |
| 10 | Declared access classes enforced (READ never persists, NO_DB never connects, WRITE persists only changes) | **PASS** | `tests/online/neon-guard.test.ts`: 45 read calls upload nothing; NO_DB moves zero bytes and materialises no file; a refused write persists nothing; the audit script keeps the registry complete. |
| 10a | Caching cannot serve stale financial data | **PASS** | Reuse requires a server 304; the ETag derives from change watermarks. Tested: 200 after an insert, an in-place edit, a receipt, a reversal, a document-settings change, a template save, and a write by another instance; LIVE/TEST and module/permission scoping. |
| 11 | Security controls unchanged | **PASS (same scope as v2.7.0)** | `tests/integration/security.test.ts` (now including administrator-only enforcement of the new diagnostics route, with a forged-role attempt). No external penetration test; `npm audit` cannot run. |
| 12 | Accounting reconciliation | **PASS on test data** | Trial balance, balance sheet, P&L, cash flow, AR/AP and GL reconcile against hand-computed books. No financial logic changed in v2.7.1. **Not reviewed by a CA**, not run against real customer data. |
| 13 | GST/TDS statutory output | **NOT VERIFIED** | Unchanged in this release. Must be reviewed by a qualified accountant before anyone files from it. |
| 14 | Upgrade of a v2.6.30 / v2.7.0 database | **PASS on test fixtures** | `tests/integration/db-open.test.ts`, `data-parity.test.ts` and the online legacy-conversion test. A pre-migration backup is written first; nothing is renumbered. The one-time conversion cost is measured (about 3.4 MB down, 1.3 MB up per 1.9 MB organization file). Not run on a copy of a real production database. |
| 15 | Backup / restore / rollback | **PASS (offline and online on PG16)** | Offline backup → restore yields an identical trial balance; `scripts/online-snapshot-tool.ts` export → import → rollback with integrity checks. |
| 16 | Deployment | **NOT VERIFIED** | Not deployed. Your approval is required. The Docker runtime stage now copies `scripts/` and `next.config.mjs` (without them the image could not start); reviewed, not built. |

## Measured transfer (one session, cold instance, PostgreSQL 16)

| Metric | v2.7.0-rc.1 | v2.7.1 | v2.7.2 |
|---|---:|---:|---:|
| Database download | 3,396.6 KB | 321.7 KB | 304.4 KB |
| Database upload | 506.1 KB | 120.4 KB | 113.2 KB |
| API response bytes (uncompressed) | 5,498.5 KB | 3,012.2 KB | 3,012.2 KB |
| Write on a 3 MB file, warm (down/up) | — | 19.0 / 38.6 KB | 0.6 / 27.0 KB |
| Write on a 3 MB file, fresh instance (down/up) | — | 19.0 / 331.6 KB | 0.6 / 32.5 KB |
| Public login page visit (download) | 801.0 KB | 0.4 KB | 0.4 KB |

## Residual risks (open)

1. **No lockfile, no production build, no lint.** Builds are not reproducible until gate 1 closes.
2. **Neon not exercised.** The figures above are PostgreSQL protocol bytes on a local server. Neon
   adds TLS overhead and meters on its own side; compare with its dashboard before trusting a
   monthly projection.
3. **One-time upgrade cost.** The first request per organization and environment rewrites that
   snapshot (format change, journal trim, blob rebuild). Take a Neon branch first; v2.7.0 cannot
   read the new format, so rollback means restoring that branch.
4. **Base-blob rebuilds** still land on roughly one write in nineteen for a 3 MB file (~30 KB when
   they do); that is what keeps a cold read at 409 KB instead of ~675 KB. The v2.7.1 19 KB
   manifest read per write and its 331 KB rebuild are fixed (see `docs/PERFORMANCE-v2.7.2.md`).
8. **Access classes are declared, not inferred.** The audit catches missing or contradicted
   declarations and the runtime guard blocks a read that tries to persist, but a route declared
   WRITE when it only reads is not detected automatically.
9. **Read coalescing is per instance**, and diagnostics counters from the last 30 seconds of a
   serverless instance may be lost at shutdown (offline installs keep them in memory only).
10. Backup endpoints now report a never-used environment as empty instead of creating it on read.
   Intended, but it is a behaviour change: the first write creates the environment.
5. **First load of a large screen is still 350–470 KB of JSON** (about 20 KB compressed). Row
   pagination and field trimming were deliberately not done: the screens compute financial totals
   over the whole table and all but 7 columns are read somewhere in the UI.
6. **Diagnostics are a lower bound,** not a bill, and in-memory only in offline mode; counters
   collected in the last 30 seconds of a serverless instance's life may be lost.
7. Carried over from v2.7.0: `xlsx` 0.18.5 advisories on the import path; `'unsafe-inline'` in the
   CSP; license enforcement off by default; login throttling keyed on IP + username; inventory not
   carried in the GL and purchase GST not posted; Report Groups does not eliminate intercompany
   balances; GST/TDS pending CA review.

## To reach "production-ready"
1. `npm install`, commit `package-lock.json`, then `npm run build`, `npm run lint`, `npm run typecheck`
   and `npm run test:all` on Node 20 or 22.
2. Point `SOLIVY_TEST_PG_URL` at a Neon branch; run `npm run test:online`, `npm run bench:online`
   and `npm run bench:client`, then compare the Neon data-transfer meter with the diagnostics screen.
3. Restore a copy of the production databases into staging, upgrade there, and compare every report.
4. Have a CA review the GST/TDS output.
5. Approve deployment.
