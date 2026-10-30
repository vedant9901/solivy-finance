# SOLIVY Finance v2.7.2 NEON GUARD — transfer report

All figures come from benchmarks in this repository against a **real PostgreSQL 16 server**, driving
the real UI in a real browser. **No Neon project was used**, so these are PostgreSQL protocol bytes
on the wire — what Neon meters as data transfer, without the TLS overhead Neon adds. They are a
lower bound on a Neon bill and are never presented as one. Method and harnesses:
`docs/PERFORMANCE-v2.7.1.md` §"How it was measured" (unchanged).

## One user session, cold instance (15 steps)

`docs/bench/client-before-v2.7.0.json` → `client-after-v2.7.1.json` → `client-after-v2.7.2.json`,
pass B (steady state, application instance with no local copy):

| Metric | v2.7.0-rc.1 | v2.7.1 | v2.7.2 |
|---|---:|---:|---:|
| Database download | 3,396.6 KB | 321.7 KB | **304.4 KB** |
| Database upload | 506.1 KB | 120.4 KB | **113.2 KB** |
| API response bytes (uncompressed) | 5,498.5 KB | 3,012.2 KB | 3,012.2 KB |
| API requests | 51 | 55 | 55 |

The one-time upgrade pass (pass A) is 3,399.1 KB down and 1,220.5 KB up, against 1,295.0 KB up in
v2.7.1: the read paths no longer create tables, so less churn is published.

## Where v2.7.2 changes the picture: larger files

Server-side scenarios, 3 organizations × 600 purchases, 3 MB organization files
(`docs/bench/after-v2.7.1.json` → `after-v2.7.2.json`):

| Scenario | v2.7.1 down/up | v2.7.2 down/up |
|---|---|---|
| `POST /api/parties`, warm instance | 19.0 / 38.6 KB | **0.6 / 27.0 KB** |
| `POST /api/parties`, fresh instance | 19.0 / 331.6 KB | **0.6 / 32.5 KB** |
| `GET /api/data` dashboard, fresh instance | 437.8 / 1.1 KB | **409.8 / 1.2 KB** |
| `GET /api/data` repeat, warm instance | 0.4 / 0.5 KB | 0.4 / 0.5 KB |
| `GET /api/secondary-backup` (5-minute poll) | 0.3 / 0.3 KB | 0.3 / 0.3 KB |

The two write rows are the v2.7.1 regressions this release removes, and the cause turned out to be
the thing the access classes were built to find: four GET endpoints and one calculation POST were
quietly modifying their database.

- `GET /api/bank`, `GET /api/tally-mapping`, `GET /api/tally-export` and `GET /api/transfers` each
  ran `CREATE TABLE IF NOT EXISTS` on the read path.
- `POST /api/tds-check` is a calculation check, but it was being audited and given an idempotency
  key like a posting.

Every one of those published a new snapshot version. The next write then had to re-materialise the
file (the 19 KB manifest read), and the accumulated page churn triggered a whole-file base blob
rebuild (the 331.6 KB upload). With reads no longer writing, a posting on a 3 MB file costs 27 KB
and the blob is rebuilt on its own amortised schedule.

Reads now create nothing: a database that does not exist is reported as empty instead of being
brought into existence by a backup or a listing.

## The guarantees, and the tests that hold them

`tests/online/neon-guard.test.ts` (9 tests, real PostgreSQL):

| Guarantee | Test |
|---|---|
| Every route and method declares READ, WRITE or NO_DB | `scripts/check-api-access.cjs` (in `npm run check:legacy`): 68 routes, 92 checks; fails on a missing, extra or contradictory declaration |
| READ endpoints never upload a snapshot | 45 read calls across every registered READ endpoint; asserts zero uploaded bytes and no snapshot version change |
| An unchanged request transfers nothing but the version check | three repeats answered 304 with zero chunks, zero base blobs, zero uploads |
| NO_DB endpoints reach neither PostgreSQL nor a snapshot | zero bytes both ways and no file materialised on disk |
| WRITE endpoints persist only real changes | a refused write leaves the version untouched and uploads nothing; a real one uploads a bounded number of pages |
| Identical concurrent reads are coalesced | five simultaneous identical reads → one hydration, identical bodies |
| Caches are isolated | another user, another environment and another organization never reuse a representation |
| Budget alerts fire once per threshold | 50/75/90/100% crossings recorded once each, with a month-end projection |
| A spike names the responsible endpoint | a steadily large endpoint is not flagged; one that jumps 30× over its own median is |

Runtime enforcement lives in the bridge: the access class comes from `lib/api-access.ts`, not from
the call site, so a route cannot grant itself write access. If a READ route ever does change its
database, the change is **not uploaded**, a counter increments, the reason is logged, and the
Administration panel shows it as a defect to report.

## Monthly budget monitoring

`SOLIVY_TRANSFER_BUDGET_GB` (default 25) sets the allowance. Month-to-date usage is summed from the
application's own per-request counters and compared against it; thresholds at 50%, 75%, 90% and
100% are each raised once per month and recorded in `solivy_transfer_alerts`, so a restart or a
second instance does not repeat them. The panel and `GET /api/admin/transfer-metrics` also show a
month-end projection from the elapsed days.

Spike detection compares each endpoint's bytes today against its own median over the previous days
in the window, flagging those at least 3× above it (or with no history) that moved at least 5 MB.
That identifies the endpoint behaving unusually rather than simply the busiest one.

## Known limitations

1. **Neon was not measured.** Every number here is local PostgreSQL protocol traffic. Neon adds TLS
   and meters on its own side; its dashboard remains the billing figure. The panel labels its own
   figures as application-measured.
2. **The diagnostics are a lower bound** and exclude TLS, protocol overhead and connection setup.
   Counters from the last 30 seconds of a serverless instance's life may be lost at shutdown, and
   offline installs keep them in memory only.
3. **Access classes are declared, not inferred.** The audit script checks exports, bridge usage and
   obvious write statements, and the runtime guard blocks a read that tries to persist — but a route
   newly declared WRITE when it only reads will not be caught automatically.
4. **Read coalescing is per instance.** Two serverless instances serving the same request still
   hydrate once each.
5. **First load of a large screen is still 350–470 KB of JSON** (about 20 KB compressed). Row
   pagination and field trimming remain deliberately undone: the screens compute financial totals
   over whole tables, and all but 7 columns are read somewhere in the UI.
6. **Base-blob rebuilds still land on one write in roughly nineteen** for a 3 MB file (~30 KB when
   they do). That is the cost of keeping cold reads at 409 KB instead of ~675 KB.
7. A database that has never been used is now reported as empty by backup endpoints instead of
   being created on read. That is the intended behaviour, but it is a change: the first write to an
   environment is what brings it into existence.
