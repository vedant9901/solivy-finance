# SOLIVY Finance v2.5.71 — Sync Connection Verification Candidate

## Changes
- Added `POST /api/sync/verify`, a read-only pairing check that uses the local sync device ID and tests the remote device token against the selected remote company and environment.
- Added **Test connection** to `/sync` so users can verify server reachability, token validity, destination company authorization and LIVE/TEST alignment before attempting data sync.
- Clarified that offline and online company IDs may differ. The online destination ID is supplied separately and authorized by the pairing token.
- Improved first-sync safety messaging: verification does not transfer records; historical data requires a separately verified initial migration/baseline; HTTP 409 conflicts must not be force-overwritten.
- Existing quality deduction changes from the v2.5.70 source are retained.

## Important limitation
This release does **not** automatically merge independently populated databases or resolve existing primary-key collisions. The current incremental sync deliberately rejects ambiguous conflicts (including a record with the same primary key and `base_json = null`). If both databases already contain records, back up both and perform a verified initial migration/reconciliation before incremental sync. Do not use this candidate against LIVE data until full production build and SQLite/PostgreSQL integration tests pass.

## Verification status
- `node scripts/check-sync.mjs`: expected to validate sync source invariants.
- `node scripts/check-database-bridge.mjs`: run after changes.
- `node scripts/check-source.cjs`: run after changes.
- Full `npm run build` and live database integration tests were not run in this environment.
