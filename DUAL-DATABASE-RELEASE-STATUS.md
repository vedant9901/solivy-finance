# SOLIVY Finance v2.5.30 — Offline + Online Database Fix

This file supersedes the v2.5.29 dual-database candidate notes.

- Offline mode remains local SQLite on Windows.
- Online Vercel mode uses PostgreSQL as durable storage for SQLite database snapshots, with a PostgreSQL advisory lock serializing bridged API requests.
- 45 API route files use the bridge (44 routes that already imported `lib/db` plus `/api/login-companies`).
- Existing finance logic is retained rather than rewritten into native PostgreSQL SQL in this patch.
- Set `DATABASE_URL` in Vercel. Do not set `SOLIVY_NATIVE_PG_AUTH=1` unless the separate native PostgreSQL auth tables have been intentionally provisioned.
- To seed an existing local installation into online mode, take a backup first and run `npm run db:upload-sqlite-snapshots` with `DATABASE_URL` configured. This overwrites matching snapshot keys in the target PostgreSQL database.
- `npm run check:database-bridge` checks that database-using route files are wrapped.

**Status:** candidate source archive, not production-verified. This environment could not complete `npm install`, so the Next.js build and live Neon tests still need to run in an environment with dependencies and a configured database.
