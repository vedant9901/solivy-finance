# v2.6.0 Vercel build fix

## What was fixed
- SQLite filesystem access was moved out of `lib/db.ts`.
- The online Vercel build aliases `./db-sqlite` to a no-op stub using Next.js 16 Turbopack `resolveAlias`.
- This prevents `better-sqlite3`, `FINANCE_DATA_DIR`, `path.resolve(...)`, and SQLite filesystem code from being traced into Vercel serverless functions.
- Offline builds remain SQLite-based. `INSTALL-SOLIVY-LOCAL.ps1` now writes `DEPLOYMENT_MODE=offline` into `.env.local` before building.

## Vercel environment variables
Set these in Production:
- `DEPLOYMENT_MODE=online`
- `DATABASE_URL=<full Neon PostgreSQL connection string>`
- `SESSION_SECRET=<strong random secret>`

## Offline
The installer continues to use `better-sqlite3` and stores financial data in the selected `FINANCE_DATA_DIR`.
