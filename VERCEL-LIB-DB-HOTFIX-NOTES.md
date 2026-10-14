# SOLIVY Finance v2.5.23 — Vercel SQLite initialization hotfix

This source bundle fixes the reported `ENOENT: mkdir '/var/task/.solivy-finance/data'` startup/import error. `lib/db.ts` no longer creates SQLite directories on Vercel, and it refuses to silently use ephemeral SQLite files. `/api/login-companies` uses Neon PostgreSQL when `DATABASE_URL` is configured and lazily imports SQLite only for local Windows mode.

## Setup
1. Back up the project and all SQLite databases.
2. In Vercel, set `DATABASE_URL` to your Neon pooled connection string.
3. Ensure Neon has a `companies` table with `id`, `name`, `code`, and boolean `active` columns.
4. Run `npm install`, then `npm run build`, then deploy.

## Important limitation
This is a **targeted lib/db/Vercel crash hotfix**, not a complete migration of all finance APIs to PostgreSQL. The rest of v2.5.23 uses synchronous SQLite calls; those endpoints will now return an explicit SQLite-disabled error on Vercel instead of attempting to write to the deployment filesystem. Do not use this bundle for live online financial operations until all API routes and schema migrations are ported and regression-tested against Neon. Windows local SQLite behavior is preserved.
