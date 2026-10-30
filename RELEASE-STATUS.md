# SOLIVY Finance v2.7.2 — Release verification report

**Status: RELEASE CANDIDATE — NOT PRODUCTION-READY.** The same gates that blocked v2.7.0-rc.1 are
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
| 5 | Unit and integration tests (offline/SQLite) | **PASS** | `npm test`: **67/67**. |
| 6 | Online tests (PostgreSQL bridge) | **PASS on PostgreSQL 16 / NOT VERIFIED on Neon** | `npm run test:online`: **31/31** against a local PostgreSQL 16, including the 9 NEON GUARD tests (`tests/online/neon-guard.test.ts`). Covers multi-instance concurrency, delta chunks, the 4 KiB page-aligned format, the base blob, corruption fallback, the login projection, metrics, idempotency, sync end-to-end, backup/restore/rollback. Neon specifics (pooler, TLS, latency, billing meter) untested. |
| 7 | Browser UI test | **PASS (component level)** | `npm run test:ui`: **4/4** (Playwright Chromium). The UI is an esbuild bundle, not `next dev`/`next start`. |
| 8 | Legacy regression scripts (`scripts/check-*`) | **PASS** | All 22 scripts exit 0, including `check-api-access.cjs` (68 routes, 92 checks). |
| 9 | Transfer reduction measured before/after | **PASS on local PostgreSQL (measured) / NOT VERIFIED on Neon** | Per-workflow byte accounting in `docs/PERFORMANCE-v2.7.1.md` from `docs/bench/client-before-v2.7.0.json` vs `client-after-v2.7.1.json`, plus `after-v2.7.0.json` vs `after-v2.7.1.json`. Neon's own data-transfer meter was not read. |
| 10 | Declared access classes enforced (READ never persists, NO_DB never connects, WRITE persists only changes) | **PASS** | `tests/online/neon-guard.test.ts`: 45 read calls upload nothing; NO_DB moves zero bytes and materialises no file; a refused write persists nothing; the audit script keeps the registry complete. |
| 10a | Caching cannot serve stale financial data | **PASS** | Reuse requires a server 304; the ETag derives from change watermarks. Tested: 200 after an insert, an in-place edit, a receipt, a reversal, a document-settings change, a template save, and a write by another instance; LIVE/TEST and module/permission scoping. |
| 11 | Security controls unchanged | **PASS (same scope as v2.7.0)** | `tests/integration/security.test.ts` (now including administrator-only enforcement of the new diagnostics route, with a forged-role attempt). No external penetration test; `npm audit` cannot run. |
| 12 | Accounting reconciliation | **PASS on test data** | Trial balance, balance sheet, P&L, cash flow, AR/AP and GL reconcile against hand-computed books. No financial logic changed in v2.7.1. **Not reviewed by a CA**, not run against real customer data. |
| 13 | GST/TDS statutory output | **NOT VERIFIED** | Unchanged in this release. Must be reviewed by a qualified accountant before anyone files from it. |
| 14 | Upgrade of a v2.6.30 / v2.7.0 database | **PASS on test fixtures** | `tests/integration/db-open.test.ts`, `data-parity.test.ts` and the online legacy-conversion test. A pre-migration backup is written first; nothing is renumbered. The one-time conversion cost is measured (about 3.4 MB down, 1.3 MB up per 1.9 MB organization file). Not run on a copy of a real production database. |
| 15 | Backup / restore / rollback | **PASS (offline and online on PG16)** | Offline backup → restore yields an identical trial balance; `scripts/online-snapshot-tool.ts` export → import → rollback with integrity checks. |
| 16 | Deployment | **NOT VERIFIED** | Not deployed. Your approval is required. |

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
