# SOLIVY Finance v2.5.58 — Sync TypeScript Build Fix

## Fix
- The Offline / Online Sync page now includes a typed `kind` field in every error explanation returned by `explainError`, matching the `Notice` state type.
- Error, warning, and offline statuses keep their appropriate visual severity.
- Includes the v2.5.57 TEST-to-LIVE after purge fix unchanged.

## Verification
- Run `npm run check:source`, `npm run check:security`, `npm run check:test-to-live`, `npm run check:sync`, and `npm run build` in the release environment.
- Test TEST-to-LIVE promotion using disposable databases before any client deployment.
- Do not use this build to overwrite a non-empty LIVE database.
