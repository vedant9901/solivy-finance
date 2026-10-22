# SOLIVY Finance v2.5.38 — Party Aliases data and layout correction

- Restored the simpler Party Aliases form/list layout, retaining a persistent desktop sidebar and mobile drawer.
- The alias endpoint now returns explicit active party records and active third-party records from the selected organization/environment database, independently of `/api/data` menu-filtering.
- The UI uses this endpoint as its single data source, avoiding a mismatch between alias rows and the party selector and avoiding permission-filtered `/api/data` results being mistaken for missing records.
- Load errors are surfaced to the user rather than silently presenting an empty list.
- Alias writes remain scoped to the selected organization and TEST/LIVE database via existing request headers and database bridge.

Verification: source audit, import-schema checks, database-bridge source audit and ZIP integrity passed. Full Next.js production build and live SQLite/PostgreSQL end-to-end tests were not run in this environment.
