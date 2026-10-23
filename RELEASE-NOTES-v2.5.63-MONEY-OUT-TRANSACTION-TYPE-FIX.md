# SOLIVY Finance v2.5.63 — Money Out Transaction Type Fix

## Fix
- Corrected `app/api/money-out/route.ts` to execute the `better-sqlite3` transaction wrapper when posting Money Out. The handler now receives the expected `{ id, paymentNo }` result instead of a transaction function, resolving the reported TypeScript error at `result.id`.
- Added regression assertions that both the source Money Out transaction and paired destination Money In transaction are invoked and return their inserted IDs.

## Verification
- TypeScript/TSX syntax parse and source-level regression checks are run for this package.
- A full `next build` and end-to-end database test must still be run in the target environment with dependencies installed; source-level checks alone do not certify production readiness.
