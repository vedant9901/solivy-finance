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
- An absent record resolves deterministically per operation (`lib/sync-absent.ts`): an already-done
  deletion is a no-op, a never-received record is restored, and an edit against a record deliberately
  deleted here is kept in the quarantine rather than resurrecting it.

## Tests
`tests/` contains unit, integration (SQLite), online (real PostgreSQL), ui (Playwright) and bench suites. Commands are in `docs/OPERATIONS.md` §9.
