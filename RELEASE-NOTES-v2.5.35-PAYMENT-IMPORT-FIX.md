# SOLIVY Finance v2.5.35 — Payment Import Build Fix

## Fixes
- Fixed the TypeScript scope error in `app/api/import-finance/route.ts`: `companyId` and `mode` are passed explicitly into the import dispatcher.
- Improved company-account name matching to normalize Unicode compatibility forms, non-breaking/zero-width spaces, case, and repeated whitespace.
- Improved the missing-account diagnostic to report the selected organization ID and TEST/LIVE environment, plus active account names available in that selected organization/environment.
- Preserved the existing database bridge, license enforcement, and organization scoping. The import does not search other organizations or silently use inactive accounts.

## Validation performed
- `node scripts/check-source.cjs` — PASS (64 files checked).
- `node scripts/check-import-schema.mjs` — PASS (6 checks).
- `node scripts/check-database-bridge.mjs` — PASS (46 API route files audited).
- `node scripts/check-security.cjs` — PASS.
- `node scripts/license-tool.cjs self-test` — PASS.
- ZIP integrity — checked after packaging.

## Not verified
A full `npm run build` was not completed in this environment because `npm install --ignore-scripts --no-audit --no-fund` timed out before installing Next.js/TypeScript. Run `npm install` and `npm run build` on the Windows machine before deploying. This release does not claim end-to-end tests against the customer's actual SQLite or PostgreSQL data.

## Important account behavior
The payment import resolves the account only in the selected company and TEST/LIVE database. If `demo` exists only in TEST while importing in LIVE (or in a different organization), the import correctly rejects it and reports which database context was searched. Ensure the account is active in the selected organization/environment before retrying.
