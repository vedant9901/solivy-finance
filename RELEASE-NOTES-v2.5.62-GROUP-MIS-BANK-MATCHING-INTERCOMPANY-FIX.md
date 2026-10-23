# SOLIVY Finance v2.5.62 — Group MIS, Bank Matching and Inter-Company Fixes

## Changes

- Group MIS now allows multi-selecting the organizations included in a report. Server-side authorization validates every selected organization against the signed-in user's mapping and the selected LIVE/TEST environment.
- Top parties are ranked by posted purchase net payable and show purchase count/value; the old ledger debit/credit transaction-volume ranking is removed.
- Bank Matching now reads all posted account transactions, not just vendor payments. It includes transaction date/type/reference, narration, party/counterparty, bank/cash account, recorded amount, statement date/amount/reference, matched status and a guarded amount-difference confirmation.
- Fixed the `NextResponse.json` response-init type error: `difference` is returned in the JSON response body rather than passed as an unsupported `ResponseInit` option.
- Money Out supports an optional mapped destination organization for `Other Money Out` and `Loan Principal Repayment`. On successful posting, the destination receives a matching `INTERCOMPANY_RECEIPT` Money In entry and account credit. The destination must have an active bank/cash account. Refunds remain party refunds and cannot be routed to another organization.
- Inter-company Money Out reversal attempts to reverse the paired destination receipt and compensates the destination reversal if the source-side reversal fails.
- Funding-capacity estimate now uses current bank/cash balance plus uncollected book profit. The label explicitly says this is a planning estimate and not cash in hand. Realised finance profit remains separate and interest is deducted from it.
- Added browser-persisted colour themes (teal, blue, violet, emerald, rose) and applied them to core UI accents/charts and generated Payment Advice / Purchase Bill PDF accents.
- Added browser-persisted English/Hindi/Gujarati selector and expanded navigation translations.
- Fixed Money Out reversal requests to include the currently selected company/environment instead of defaulting to company 1.

## Verification performed

- TypeScript/TSX parser syntax audit across all 76 source files.
- `scripts/check-source.cjs` passed.
- `scripts/check-money-out.cjs` passed, including inter-company receipt checks.
- `scripts/check-multicompany-sync.cjs` passed, including selected-company scope and purchase-based top-party checks.
- `scripts/check-release-fixes.cjs` passed.
- `scripts/check-security.cjs` passed.
- `scripts/check-sync.mjs` passed.
- `scripts/check-test-to-live-purge-fix.mjs` passed.
- `scripts/check-user-org-conflicts.cjs` passed.
- License signing/verifier self-test passed.
- SQLite schema and all-transaction Bank Matching query/upsert smoke test passed in an isolated in-memory database.
- ZIP integrity and packaged-secret-file audit performed before delivery.

## Verification limitations

Dependency installation could not complete in the build environment (registry access timed out and dependencies were not cached). Therefore, a full `next build` / semantic TypeScript check and end-to-end browser/PostgreSQL tests were **not** completed. The checks above are source/regression and SQLite smoke tests, not production certification.

The language selector persists the choice and translates navigation; it does not yet translate every hard-coded label, message, report, or PDF sentence throughout the entire application. Full app-wide English/Hindi/Gujarati localization still requires a complete translation catalogue and review. PDF colour accents follow the selected theme; the invoice body remains black-and-white by design.

## Deployment notes

1. Back up the admin database and each company's LIVE and TEST databases before replacing the build.
2. Install dependencies on the build machine, run `npm run check:release-fixes` and the existing regression checks, then run `npm run build`.
3. Validate inter-company Money Out in TEST with two mapped organizations and active destination accounts before using LIVE.
4. Review both organizations' ledgers and bank/cash balances after the test transfer and after reversing it.
