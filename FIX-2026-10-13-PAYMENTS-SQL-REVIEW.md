# SOLIVY Finance v2.5.23 — Payment SQL correction (2026-10-13)

## Corrected
- Fixed the missing closing parenthesis around the correlated `SELECT SUM(...)` subqueries in `app/api/payments/route.ts` (`normalizeAllocations` and both subqueries in `autoAllocations`).
- Fixed the missing fifth SQLite bind parameter in `autoAllocations`.
- Executed both corrected SQL statements against an in-memory SQLite database with representative tables/rows: PASS.
- Ran `node scripts/check-source.cjs`: PASS (57 source files parsed).
- Ran `node scripts/check-import-schema.mjs`: PASS (6 checks).
- Ran `node scripts/check-security.cjs`: PASS (static checks only).
- Ran `node scripts/license-tool.cjs self-test`: PASS (license signing/verification self-tests).

## Verification limitations — do not treat as full production certification
- `npm install --no-audit --no-fund` timed out in the build environment; `npm run build` could not be executed here.
- This source's Neon/PostgreSQL integration currently covers `/api/login-companies` only. The rest of the finance API routes still call the SQLite API (`db(...).prepare()`, `.transaction()`, etc.). Therefore, this archive does **not** provide complete online Neon support for payments and all finance modules.
- Do not use Vercel for real financial transactions until all finance APIs and schema migrations have been ported to PostgreSQL and integration-tested. Local Windows SQLite remains the intended supported mode for those APIs in this candidate.
