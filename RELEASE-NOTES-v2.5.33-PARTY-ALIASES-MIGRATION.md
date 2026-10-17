# SOLIVY Finance v2.5.33 — Party Aliases & Import Review

## Changes
- Added a party-alias manager at `/party-aliases`, linked from the main navigation.
- A party can have multiple alternate names. Aliases are unique and cannot conflict with another party's name/alias.
- Finance import party matching now checks canonical party names and saved aliases.
- Imports that create parties return a downloadable XLSX report listing newly created ledger names and the import type.
- Alias records are stored in the same company/environment database as the party ledger; LIVE and TEST remain separate.
- Added the alias table to the normal database schema creation/migration path.

## Mid-year onboarding recommendation
1. Select company, financial year, and opening cut-off date.
2. Import party masters and aliases first.
3. Import opening balances and outstanding bills separately from transaction history.
4. Optionally import bank statements into a preview/matching queue; do not post unmatched entries automatically.
5. Review the new-ledger XLSX report and reconcile party and bank opening balances before going LIVE.

## Verification performed
- `node scripts/check-source.cjs` — PASS
- `node scripts/check-import-schema.mjs` — PASS
- `node scripts/check-database-bridge.mjs` — PASS
- `node scripts/check-security.cjs` — PASS
- `node scripts/license-tool.cjs self-test` — PASS
- Full Next.js production build and end-to-end SQLite/PostgreSQL transactions were not run in this environment; do not treat this as production-certified until those checks pass against a test database.
