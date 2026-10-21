# SOLIVY Finance v2.5.54 — Dynamic Module Access Fix

## Root cause
The User Management UI exposed `party-aliases` and `transfers`, but the `/api/users` persistence allowlist and login allowlist omitted those IDs. The API therefore filtered those selected IDs out, so they disappeared on the next edit/login. Separately, middleware enforced signed-license feature IDs before checking admin/user menu assignments, producing `LICENSE_FEATURE_LOCKED` even when a module had been assigned in User Management.

## Changes
- Added `party-aliases` and `transfers` to the persisted and login menu catalogs.
- Made user record + company assignment updates transactional so failed saves do not leave partially updated company mappings.
- Added explicit API entitlement mapping for party aliases and inter-company transfers.
- Allows administrators, and non-admin users with the corresponding menu assignment in their signed session, through the feature-level gate. Authentication, organization license validity/expiry, company mapping, environment checks, and API menu authorization remain enforced.
- Requires users to sign out/in after module permissions change so their signed session reflects the latest menu assignment.

## Verification
- TypeScript parse audit: 66 files checked.
- Security/source audit: passed.
- Import checks: 6/6 passed.
- Transfer source checks: 17/17 passed.
- License signing/verifying self-tests: passed.
- Full Next.js production build and live SQLite/PostgreSQL integration tests were not run in this environment.
