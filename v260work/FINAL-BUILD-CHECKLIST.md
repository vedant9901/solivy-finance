# SOLIVY Finance v2.5.7 — Final build checks

## Critical CSV import fix

The purchase CSV importer previously had a hard-coded SQL placeholder mismatch: 31 placeholders for 30 purchase columns. That mismatch is removed.

Purchase imports now construct the placeholder list from the exact purchase column list at runtime and assert that the column/value counts match before executing the INSERT.

## Import safety

- Required CSV headers are validated before any database write.
- Preview performs no database writes.
- Import runs inside a SQLite transaction.
- A failed row/import rolls back the transaction.
- Duplicate records are skipped according to each module's duplicate key.
- Errors are returned as JSON with HTTP 400 rather than an HTML error page.

## Local checks

    npm install
    npm run check:import
    npm run build
