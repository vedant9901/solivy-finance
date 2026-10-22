# SOLIVY Finance v2.5.47 — Party Alias Master Source Fix

- Party Aliases now independently fetches `/api/data` using the selected company and mode, then merges those Party Master records with the alias endpoint results.
- Alias API list endpoints include active and inactive ledger records so existing Party Master rows aren't silently omitted solely due to active status. Alias creation still requires an active party.
- Rows with no aliases clearly show Add alias plus disabled Edit/Delete actions; Edit/Delete are available for saved aliases. Deleting an alias never deletes a party or financial records.
- Both endpoints receive the selected company and environment headers and use no-store fetches to avoid stale lists.

## Verification status
Source-level changes only. Run `npm run build`, `npm run check:source`, `npm run check:database-bridge`, and end-to-end tests against SQLite and PostgreSQL/Neon before production use. A full production build and real database end-to-end tests have not been certified in this package environment.
