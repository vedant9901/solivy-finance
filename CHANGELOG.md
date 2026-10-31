# Changelog

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
