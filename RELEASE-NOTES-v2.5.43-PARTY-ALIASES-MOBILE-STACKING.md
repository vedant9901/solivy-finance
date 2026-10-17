# SOLIVY Finance v2.5.43 — Party Aliases and Mobile Stacking Fix

- Keeps the SOLIVY logo/mobile workspace header sticky at the top.
- Raises the mobile drawer/backdrop above the page-level sticky header and standardizes z-index stacking.
- Party Aliases now renders all parties from Party Master, including parties without any alias, and displays aliases next to the matching ledger.
- Third Parties list is sourced from `/api/data` using the selected company and TEST/LIVE mode; request includes the user's menu-access context so authorized records are returned consistently.
- Alias export includes parties with blank aliases, making the CSV useful as a migration mapping template.

## Validation
- ZIP archive integrity checked.
- Source checks attempted where available. Full Next.js production build and offline SQLite / online PostgreSQL end-to-end tests have not been run in this environment; run `npm install` and `npm run build` before production deployment.
