# SOLIVY Finance v2.5.17 — Premium UI Icon Build Fix

## Fix
- Replaced the invalid `FiArrowLeftRight` import from `react-icons/fi` with the supported Feather icon `FiRepeat` in `app/page.tsx`.
- Updated package version to 2.5.17.
- Kept the v2.5.16 premium dashboard design and did not intentionally modify financial calculations, API routes, SQLite persistence, session/authentication, or permissions.

## Checks performed in this environment
- `node scripts/check-source.cjs`: PASS (47 TypeScript/TSX files parsed).
- `node scripts/check-security.cjs`: PASS.
- `node scripts/check-import-schema.mjs`: PASS (6 checks).
- ZIP integrity: checked after packaging.

## Not claimed
Dependency installation timed out in this environment. A real `next build` and end-to-end workflow tests were not completed. This package must not be represented as production-build-verified until those tests pass.
