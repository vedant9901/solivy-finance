# SOLIVY Finance v2.7.1 — API and transfer performance report

Every figure here was produced by a benchmark in this repository against a real PostgreSQL 16
server, driving the real UI in a real browser. **Neon itself was not used** (no Neon project was
available in the build environment), so the database figures are PostgreSQL protocol bytes on the
wire, which is what Neon meters as data transfer, plus TLS overhead Neon adds and this measurement
does not.

## How it was measured

| Harness | What it does | Command |
|---|---|---|
| `tests/bench/client-bench.ts` | Chromium (Playwright) runs the real `app/page.tsx` and login screen against the real API routes; the server runs in online mode against PostgreSQL. Per workflow step it records API requests, repeat requests, response bytes seen by the browser, and PostgreSQL socket bytes read/written by the server. | `npm run bench:client` |
| `tests/bench/bridge-bench.ts` | Server-side scenarios (3 organizations, 600 purchases each) in cold / warm / fresh-instance passes. | `npm run bench:online` |
| `tests/bench/write-cost.ts` | Chunk-level cost of one posting, and of a cold read. | `npm run bench:write` |
| `tests/bench/response-size.ts` | What the JSON payloads cost compressed, as a browser downloads them. | `npm run bench:response` |

Data set for the client benchmark: one organization, 40 parties, 300 purchases, 100 vendor
payments, 60 receipts, two organizations in the account. Snapshot files before the upgrade:
admin 606 KB, organization 1.9 MB.

The client benchmark runs the same 15-step workflow twice:
- **Pass A** — the first use of an existing database by this build: legacy row conversion, schema
  upgrade, chunk-format change and the first journal trim all happen here. One-time.
- **Pass B** — steady state: a new browser, and an application instance with no local copy (what a
  serverless cold start sees).

Both are reported. Pass B is the number that recurs.

## Before and after — one user session (15 steps, cold instance)

v2.7.0-rc.1 baseline (`docs/bench/client-before-v2.7.0.json`) against v2.7.1 pass B
(`docs/bench/client-after-v2.7.1.json`), comparable steps only:

| Metric | v2.7.0-rc.1 | v2.7.1 | Change |
|---|---:|---:|---:|
| Database download | 3,396.6 KB | **299.0 KB** | −91% |
| Database upload | 506.1 KB | **73.2 KB** | −86% |
| API response bytes (uncompressed) | 5,498.5 KB | **2,508.5 KB** | −54% |
| API requests | 51 | 47 | −8% |

Per workflow step:

| Step | Requests b/a | Response KB b/a | DB down KB b/a | DB up KB b/a |
|---|---|---|---|---|
| Login page load (public) | 1 / 1 | 0.2 / 0.2 | **801.0 / 0.4** | 1.7 / 0.3 |
| Sign in + dashboard | 8 / 6 | 469.5 / 468.0 | **2,574.1 / 283.2** | 78.3 / 7.0 |
| Dashboard reload | 7 / 5 | 469.5 / 468.0 | 3.4 / 1.6 | 4.4 / 1.8 |
| Open Parties | 1 / 1 | 28.9 / 30.3 | 0.4 / 0.4 | 0.5 / 0.5 |
| Open Purchase / Sample | 1 / 1 | 346.6 / 347.9 | 0.4 / 0.4 | 0.5 / 0.5 |
| Open Payment | 1 / 1 | 436.7 / 438.0 | 0.4 / 0.4 | 0.5 / 0.5 |
| Open Vendor Ledger | 1 / 1 | 471.4 / 472.8 | 0.4 / 0.4 | 0.5 / 0.5 |
| Open Bank / Cash Account | 1 / 1 | **28.9 / 0.0** | 0.4 / 0.4 | 0.5 / 0.5 |
| Open Reports | 2 / 2 | **633.9 / 8.9** | 0.8 / 0.8 | 0.9 / 0.9 |
| Open Document Setting | 4 / 4 | **32.3 / 3.3** | 1.5 / 1.5 | 1.8 / 1.8 |
| Open Godown / Inventory | 2 / 2 | **29.0 / 0.0** | 0.8 / 0.8 | 0.9 / 0.9 |
| Repeat switching ×6 (loaded tabs) | 6 / 6 | **1,624.4 / 0.0** | 2.3 / 2.3 | 2.8 / 2.8 |
| Reports hub reopened | 2 / 2 | **633.9 / 0.0** | 0.8 / 0.8 | 0.9 / 0.9 |
| Run Balance Sheet | 2 / 2 | 4.4 / 4.4 | 0.8 / 1.0 | 0.9 / 4.6 |
| Change the as-of date, re-run | 1 / 1 | 2.2 / 2.2 | 0.4 / 0.4 | 0.5 / 0.5 |
| Open a second report | 2 / 2 | 2.9 / 1.5 | 0.8 / 0.8 | 0.9 / 0.9 |
| Create a party | 3 / 3 | 58.6 / 31.0 | 5.6 / 1.4 | **406.7 / 45.4** |
| Idle 30 s | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Zero response bytes means the server answered **304 Not Modified**: the client had the current
representation and the server confirmed it. A 304 costs about 0.4 KB of database traffic for the
version check, which is why those rows still show 0.4 KB.

The 5 repeat requests the benchmark counts as duplicates in both runs are these revalidations of
the same URL when returning to a screen. In v2.7.0 each one re-sent the whole payload; in v2.7.1
each one is a 304. They are deliberate: financial screens revalidate rather than trust a timer.

## Where the remaining cost is

**Writes.** One posting now uploads only the SQLite pages it dirtied (`tests/bench/write-cost.ts`):

| Operation | Chunks uploaded | Uploaded |
|---|---:|---:|
| Create a party | 8 of 147 | 5.9 KB |
| Create a party (next) | 8 | 6.2 KB |
| Create a purchase (posts ledger, receivable, account transaction, audit) | 17 | 10.2 KB |
| A write that also refreshes the whole-file base blob (once per ~4 writes on this 588 KB file) | 8 + blob | 32.0 KB |
| Read on a warm instance | 0 | 0 KB |
| Read on a cold instance (base blob + changed chunks) | 21 | 51.1 KB down |

v2.7.0 uploaded 406.7 KB for the same single party write, because a 16 KiB chunk covered four
SQLite pages and the whole organization journal was in the file.

**First load of a screen.** Purchases 348 KB, Payments 438 KB, Vendor Ledger 473 KB of JSON. These
rows are not trimmed, for a reason: a scan of every column against the client code found that all
but 7 columns across the large tables are read somewhere in the UI, and the screens compute
financial aggregates over the whole table (search, MIS, period views). Dropping rows or columns
would change those numbers. Instead these payloads are compressed in transit and revalidated with
ETags, and the measurement shows why that is enough (`npm run bench:response`):

| `/api/data?modules=` | Raw | gzip | Brotli |
|---|---:|---:|---:|
| `core,parties,accounts` | 3.9 KB | 0.9 KB | 0.8 KB |
| `core,parties,accounts,purchases` | 320.7 KB | 14.5 KB | 7.6 KB |
| `core,parties,accounts,payments,purchases` | 418.0 KB | 17.7 KB | 9.3 KB |
| dashboard set | 449.6 KB | 19.5 KB | 10.3 KB |
| legacy MIS set | 616.4 KB | 28.6 KB | 14.7 KB |

Next.js compresses responses it serves (`compress: true`), and Vercel's edge compresses otherwise,
so a 450 KB payload is about 20 KB on the wire. API egress is also not the Neon allowance.

## Server-side scenarios (3 organizations, 600 purchases each)

`docs/bench/after-v2.7.0.json` against `docs/bench/after-v2.7.1.json`:

| Scenario | v2.7.0 down/up | v2.7.1 down/up |
|---|---|---|
| Wrong-password login, warm | 0.5 / 0.9 KB | 0.5 / 0.9 KB |
| `/api/data` dashboard, fresh instance | 832.7 / 1.9 KB | **437.8 / 1.1 KB** |
| `/api/data` repeat, warm | 0.4 / 0.5 KB | 0.4 / 0.5 KB |
| Single write, warm | 0.9 / 34.8 KB | 19.0 / 38.6 KB |
| Single write, fresh instance | 1.0 / 55.4 KB | 19.0 / 331.6 KB |

These organization files are 3 MB each — four times the client benchmark's — and that is where the
two regressions in this table come from. Both are understood, and both are the cost of making cold
reads cheap:

- **19 KB read on a write.** At 4 KiB granularity a 3 MB file has about 750 chunks, so its manifest
  is larger. It is stored compressed and is never fetched to decide what to upload, but it is read
  when the instance materialises the file.
- **331.6 KB written on a fresh-instance write.** That request rebuilt the whole-file base blob.
  The blob is rebuilt when 20% of chunks have diverged from it, which for a 3 MB file is about one
  rebuild per 19 single-row writes (8 pages each), so the amortised cost is roughly 17 KB per
  write. The blob is what makes the cold read above cost 437.8 KB instead of the ~675 KB that
  fetching all 750 chunks would cost, and cold reads on serverless are far more frequent than
  writes.

## Monthly projection against a 25 GB allowance

This is arithmetic from the measured per-session figures, not a measured monthly total.

One full session as the benchmark drives it (sign in, open 13 screens, run 3 reports, 2 writes,
switch environment twice) on a cold instance: 299 KB down + 73 KB up ≈ **0.37 MB**.

| | v2.7.0-rc.1 | v2.7.1 |
|---|---:|---:|
| Per session | 3.81 MB | 0.37 MB |
| Sessions within 25 GB/month | ≈ 6,700 | ≈ 69,000 |

The one-time upgrade pass (pass A) costs 3.4 MB down + 1.3 MB up per organization file, because the
legacy row is converted, the chunk format changes and the first journal trim rewrites pages. Budget
it once per organization and environment.

## What made the difference

| Change | Effect (measured) |
|---|---|
| Login projection row: the public sign-in screen no longer hydrates `admin.db` | 801 KB → 0.4 KB per visit |
| `/api/companies` GET narrowed from every organization to `admin.db` | removed the whole-account hydration from sign-in |
| Group MIS and group reports hydrate only the selected organizations | was every active organization, every time |
| Duplicate dashboard fetch removed (derived selection, no state round trip) | 3 `/api/group-mis` calls per mount → 1 |
| ETag / 304 on `/api/data`, `/api/reports` and the reference endpoints, with a conditional client cache | repeat screens 1,624 KB → 0 KB of payload |
| Reports tab loads the legacy MIS tables only when that view is opened | 634 KB → 8.9 KB |
| 4 KiB page-aligned chunks | one posting uploads 6–17 pages, not 25 chunks of 16 KiB |
| Brotli instead of gzip for chunks and blobs | 1.9 MB file: 280 KB → 174 KB whole-file |
| Whole-file base blob for instances with no local copy | cold read 570 KB → 233 KB equivalent |
| Compressed chunk manifest | removed ~19 KB of protocol text per cold read of a 3 MB file |
| Journal trim for databases nothing pulls from | organization file 1.9 MB → 588 KB (the journal was 49% of it) |
| Trigger fingerprint confirmed after bookkeeping DDL | removed a 353 KB upload on the next read |
| Background sync paced by window visibility (10 min active, 30 min hidden) | fewer idle cycles; no change when a sync is configured and in use |

## Correctness alongside caching

A cached representation is only ever reused after the server confirms it with 304, and the ETag is
computed from change watermarks that move on every insert, update and delete of company data, on
every row applied by a synchronisation pull, and on every schema change — plus the caller's
organization, environment, permissions and the requested modules. The tests that hold this down:

- `tests/integration/conditional.test.ts` — 304 while unchanged; 200 after an insert, after an
  in-place edit, after a receipt, after a reversal, after a document-settings change and after a
  template save; exports never conditional; LIVE and TEST never share a representation.
- `tests/online/bridge.test.ts` — a write by another instance is visible immediately; a corrupted
  chunk is never served; a corrupted base blob falls back to the chunk set; the sign-in projection
  contains only organization id, name and code.
- `tests/integration/conditional.test.ts` (trim cases) — the audit trail is never pruned, an
  upstream pairing or an active paired device blocks the short retention, and a watermark is
  recorded so a device paired later re-baselines instead of silently missing events.
