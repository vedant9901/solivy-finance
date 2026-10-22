# SOLIVY Finance v2.5.23 — Vercel build dependency fix

This source includes the v2.5.23 license setup/perpetual-license files, the lazy SQLite initialization change (no SQLite directory creation at module import on Vercel), and the `lib/postgres.ts` adapter used by `/api/login-companies`.

## Fix for `Module not found: Can't resolve 'pg'`

The `pg` package is declared in `dependencies` and `@types/pg` in `devDependencies` in `package.json`. From the extracted project root, run:

```powershell
npm install
npm run build
```

If replacing files in an existing checkout instead of extracting this complete source, update `package.json` to include `"pg": "^8.16.3"` under `dependencies`, then run:

```powershell
npm install pg
npm install -D @types/pg
npm run build
```

Commit both `package.json` and the generated `package-lock.json`, then redeploy on Vercel.

## Environment

- Local Windows/SQLite: do not set `DATABASE_URL` if you intend to use the SQLite path.
- Vercel: set `DATABASE_URL` to the Neon PostgreSQL connection string in Project Settings → Environment Variables, for Production (and Preview if needed), then redeploy.

## Important scope note

This fixes the missing `pg` package build error and prevents SQLite filesystem initialization at module import on Vercel. The source's PostgreSQL route is currently `/api/login-companies`; the remaining SQLite-backed routes have not all been migrated to PostgreSQL by this dependency fix. Do not use this artifact as proof that all finance APIs are production-ready on Neon until those routes and the PostgreSQL schema/data migration are completed and tested.
