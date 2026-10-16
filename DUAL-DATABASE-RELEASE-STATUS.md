# SOLIVY Finance v2.5.29 — Dual-database candidate status

## Changes in this candidate
- Moved TEST-to-LIVE promotion selection state into the Administration component, where the controls are rendered.
- Passed the page message and reload callbacks into Administration, which its promotion control uses.
- Changed the Neon company lookup to filter the integer `active` column using `active = 1`.
- Hardened Vercel runtime detection so SQLite directory creation is not attempted when deployed under `/var/task`, even if a Vercel environment variable is unexpectedly absent.
- Kept local SQLite data paths and database schema logic unchanged.

## Validation actually performed
- `node scripts/check-source.cjs`: PASS (61 files parsed).
- `node scripts/check-security.cjs`: PASS (all included source checks).
- `npm install --no-audit --no-fund`: did not complete within the available execution window.
- `npm run build`: NOT RUN; dependencies could not be installed in this environment.

## Critical release limitation
This is **not a verified full online/offline production release**. The application currently has 46 API route files; 45 still depend on the SQLite data-access layer. The Vercel guard prevents the SQLite filesystem error, but those SQLite-backed APIs still need actual PostgreSQL implementations before online finance modules can work. Only the login-company lookup currently contains a PostgreSQL branch. Do not deploy this candidate as a fully working online finance system or use it for production financial transactions until that migration and integration testing are complete.

No database files or customer data were included or modified.
