# SOLIVY Finance v2.6.13 — Financial Repair Mark Reviewed Fix

## Fixes
- Removed the extra typed confirmation phrase from the individual Mark reviewed action. Admin authentication and a written reason remain required.
- Lowered the review-reason minimum to 10 characters and aligned server validation.
- Added review-table schema compatibility checks for databases created by earlier repair builds.
- Uses explicit update-or-insert rather than depending on a specific SQLite UNIQUE constraint definition.
- Verifies the saved review row before returning success; the UI refreshes diagnostics after saving.
- Keeps a pre-change database backup and audit record; original financial transaction is not modified.

## Verification
- Source patch and ZIP integrity checked.
- Full Next.js production build and live database regression tests were not run in this environment. Test on a copy of the database before deploying to LIVE.
