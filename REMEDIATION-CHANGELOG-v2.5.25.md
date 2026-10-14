# SOLIVY Finance v2.5.25 — remediation candidate

Built from the supplied v2.5.24 source and baseline audit. Existing database files are not modified by this source packaging step.

## Applied in this candidate
- Removed the predictable `changeme` password for new users; requires a user-supplied password of at least 12 characters.
- Validates user roles against ADMIN / DATA_ENTRY / VIEWER.
- Fixes date-only due-date arithmetic to use UTC calendar components and changes API default “today” values to local-date formatting, avoiding the IST midnight shift.
- CSV/XLSX import numeric parsing now preserves decimal rates, percentages, weights and amounts instead of rounding every imported field to an integer. Financial posting routes still retain their existing rounding behavior where it was present; review before production posting.
- Purchase edits are blocked when its receivable has recorded receipts, and unreceived receivable records are updated in place rather than deleted/recreated.
- Partial receipt TDS rate is stored as a weighted average instead of summing percentage rates. TDS section/reference are not erased by a later receipt that leaves them blank.
- Receivable reversal is blocked when legacy data shows multiple receipt transactions, since the existing schema cannot reliably map each receipt to its original bank account. Purchase reversal is rolled back if the receivable has recorded receipts.
- TEST-to-LIVE promotion includes additional tables (`account_movements`, `third_parties`, `company_settings`, `import_batches`, `audit_logs`) when present. Existing non-empty LIVE protection remains.
- `/api/data` now filters sensitive module arrays using signed-session menu access and `/api/data` requires dashboard entitlement for non-admin users.
- IP throttling no longer trusts spoofable forwarding headers unless `TRUST_PROXY_HEADERS=true` is explicitly configured for a trusted proxy.

## Not certified / remaining blockers
- Full `npm install`, TypeScript check, Next.js production build, `npm audit`, startup and browser/API smoke tests could not be completed in this workspace because npm registry access timed out. Do not describe this ZIP as a verified production build until these pass on Windows/CI.
- No receipt-history table was introduced, so multi-receipt reversals are intentionally blocked rather than guessed.
- Server-side session revocation/versioning, a durable distributed rate limiter, comprehensive audit logging, automated pre-purge backups, and an actual restore workflow still need implementation and tests.
- Admin is still global across companies. Backup exports remain unencrypted. Do not expose this single-owner design as a multi-tenant SaaS.
- SQLite APIs remain local/self-hosted only; Vercel/Neon support is not implemented across the application.
- GST/TDS output remains a working paper, not a statutory filing integration.
- Existing whole-rupee rounding in purchase/payment posting and the purchase calculation formula remain unchanged pending owner sign-off.

## Required verification before live use
Run `npm ci`, `npm run check:source`, `npm run check:security`, `npm run check:import`, `npm run check:license`, `npx tsc --noEmit`, and `npm run build` on Windows or CI; then test with a copy of the database. Never test migration or reversal on the only production database.
