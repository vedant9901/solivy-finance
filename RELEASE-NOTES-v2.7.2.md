# SOLIVY Finance v2.7.2 — NEON GUARD

Build: `SOLIVY-Finance-v2.7.2-NEON-GUARD`. Baseline: v2.7.1 (unchanged, tagged). No financial logic,
tax rule, report calculation, document template or UI layout changed. Measurements:
`docs/PERFORMANCE-v2.7.2.md`. Gate status: `RELEASE-STATUS.md`.

## Declared database access, enforced at runtime

`lib/api-access.ts` declares, for all **68 routes** and every method they export, whether it is
`READ`, `WRITE` or `NO_DB`. The bridge reads that registry — not its call sites — so a route cannot
grant itself write access, and `npm run check:api-access` (part of `check:legacy`) fails the build
on a missing, extra or contradictory declaration.

- **NO_DB** never reaches PostgreSQL and never materialises a snapshot (`/api/logout`).
- **READ** can never publish a snapshot. The one exception is a schema upgrade of a file the request
  had to open, because discarding that would lose the migration. Anything else is blocked, counted
  and logged as a defect, and the Administration panel shows it.
- **WRITE** persists only the pages whose bytes actually changed.

Reads also no longer create databases: an environment that has never been used is reported as empty
rather than brought into existence by a backup or a listing.

## Five read paths that were quietly writing

The guard found them, and they explain v2.7.1's two write regressions on large files:

- `GET /api/bank`, `GET /api/tally-mapping`, `GET /api/tally-export`, `GET /api/transfers` each ran
  `CREATE TABLE IF NOT EXISTS` on the read path. Those tables are now created by the write paths,
  and reads answer from them only when they exist.
- `POST /api/tds-check` is a calculation check but was audited and given an idempotency key like a
  posting. A route declared READ now gets neither.

Measured effect on a 3 MB organization file:

| Scenario | v2.7.1 down/up | v2.7.2 down/up |
|---|---|---|
| `POST /api/parties`, warm instance | 19.0 / 38.6 KB | **0.6 / 27.0 KB** |
| `POST /api/parties`, fresh instance | 19.0 / 331.6 KB | **0.6 / 32.5 KB** |
| `GET /api/data` dashboard, fresh instance | 437.8 / 1.1 KB | **409.8 / 1.2 KB** |

One user session on a cold instance: **304.4 KB down, 113.2 KB up** (v2.7.1: 321.7 / 120.4;
v2.7.0-rc.1: 3,396.6 / 506.1).

## Fewer duplicate requests and transfers

Identical concurrent READ requests share one execution: two components, a re-render or two tabs
asking for the same URL produce one snapshot hydration and one response. The key carries
organization, environment, user, role, menu permissions and `If-None-Match`, so callers with
different authority or different cached state never share a response.

## Transfer diagnostics, budget alerts and spike attribution

**Administration → API & database transfer** and `GET /api/admin/transfer-metrics?days=30` now add:

- per endpoint: declared access class, database reads, database writes, blocked upload attempts,
  requests answered 304, request and response bytes, snapshot bytes down and up;
- a per-class summary (READ / WRITE / NO_DB);
- **monthly budget**: month-to-date usage against `SOLIVY_TRANSFER_BUDGET_GB` (default 25), a
  month-end projection, and alerts at 50%, 75%, 90% and 100% raised once per month and recorded in
  `solivy_transfer_alerts` so a restart or a second instance does not repeat them;
- **spike detection**: endpoints at least 3× above their own median for the window (minimum 5 MB
  today), so the endpoint behaving unusually is named rather than the busiest one;
- the read-only guard's counters, shown as a defect to report if it ever has to block an upload.

Figures are labelled application-measured — compressed payloads this application moved, without TLS
or protocol overhead — and the panel states that the provider's own dashboard remains the bill.

## Tests

`tests/online/neon-guard.test.ts` adds 9 regression tests against real PostgreSQL: 45 read calls
across every registered READ endpoint upload nothing; unchanged requests transfer nothing but the
version check; NO_DB touches nothing; refused writes persist nothing; five concurrent identical
reads hydrate once; caches are isolated by user, environment and organization; budget thresholds
fire once each; a spike names the right endpoint; the diagnostics API reports all of it.

Totals: **102 automated tests pass** — 67 offline, 31 online (real PostgreSQL 16, not Neon), 4
browser — plus 22 legacy regression scripts including the new access audit.

## Upgrading from v2.7.1

Deploy and start; nothing in the stored format changed. New PostgreSQL tables are created on first
use (`solivy_transfer_alerts`, plus new columns on `solivy_transfer_metrics`). Set
`SOLIVY_TRANSFER_BUDGET_GB` to your provider allowance. Offline installs are unaffected.
