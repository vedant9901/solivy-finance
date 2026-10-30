# Changelog

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
