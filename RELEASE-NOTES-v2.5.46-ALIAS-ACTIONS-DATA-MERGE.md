# SOLIVY Finance v2.5.46 — Party Alias Actions & Data Merge

- Party Aliases merges party and third-party records supplied by the workspace with records returned by `/api/party-aliases`, deduplicating by numeric ID and sorting by name.
- Rows without an alias now have a visible **Add alias** action that selects that party in the form.
- Rows with aliases have visible **Edit** and **Delete** buttons.
- Edit uses the alias PUT endpoint; delete uses the alias DELETE endpoint. These routes continue to use the existing database bridge.
- No financial calculations or ledger entries are changed.

Verification performed: source parsing/audit, import-schema audit, database-bridge source audit, security/license self-tests, and ZIP integrity. Full Next.js build and live SQLite/PostgreSQL end-to-end tests were not run in this environment.
