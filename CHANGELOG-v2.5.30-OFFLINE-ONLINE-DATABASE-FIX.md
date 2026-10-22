# SOLIVY Finance v2.5.30 — Offline + Online Database Fix

## Database behavior

- Local Windows installations continue to use the existing `better-sqlite3` `live.db`, `test.db`, and `admin.db` files.
- On Vercel, API routes that use the existing SQLite data helper are wrapped by a Node.js request bridge. It hydrates temporary SQLite working files from the durable PostgreSQL table `solivy_sqlite_snapshots`, executes the existing route logic, closes the SQLite handles, and saves the resulting database files back to PostgreSQL before returning the response.
- A PostgreSQL advisory lock serializes bridged requests to prevent concurrent snapshot writes from overwriting each other.
- `DATABASE_URL` is required online. The bridge creates `solivy_sqlite_snapshots` automatically using the configured PostgreSQL role.
- A persistence error returns HTTP 503 with `DATABASE_PERSIST_FAILED` instead of claiming a write was saved.

## Deployment configuration

1. Set `DATABASE_URL` to a persistent PostgreSQL/Neon connection string in Vercel Production and Preview as required.
2. Ensure the database role can create tables and read/write rows in `solivy_sqlite_snapshots`.
3. Deploy and test login, company selection, LIVE/TEST switching, and a create/read/update/delete cycle for every major finance module.
4. Keep a verified backup before switching an existing production deployment.

## Important limitation

This is a compatibility bridge for the existing synchronous SQLite-based route logic, not a native row-by-row PostgreSQL rewrite of every business query. It persists whole SQLite database snapshots in PostgreSQL and serializes bridged API requests. It prioritizes compatibility with the existing offline build, but large datasets and high concurrent traffic should move to native PostgreSQL tables and async queries in a future migration. Deployment must be validated against a real PostgreSQL instance before this release is described as production-verified.
