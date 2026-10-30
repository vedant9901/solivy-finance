# Worklog

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
