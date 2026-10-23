# SOLIVY Finance v2.5.63 — Inter-company Funding Transfers

## Added
- Funding screen now supports a cash-only inter-company transfer. Posting uses the existing Money Out flow and creates a matching Money In entry in the destination organization.
- Added full loan transfer workflow between mapped organizations in the same LIVE/TEST environment.
- Loan transfer computes outstanding principal from posted principal repayments, creates a destination loan for the outstanding principal, and records the original loan, historical principal repayments, and prior interest schedule in a transfer-history snapshot.
- Added incoming/outgoing transfer history and a UI view for the historical repayment list and interest schedule snapshot.
- Added audit events on both organizations and guarded transfer reversal.
- Updated the PostgreSQL/Neon SQLite-snapshot bridge to hydrate and persist the destination organization database for cross-company POST requests; without this, serverless inter-company postings could target an unhydrated destination snapshot.

## Safety behavior
- Source loan status changes to TRANSFERRING before destination creation to reduce duplicate/concurrent transfers; on success it becomes TRANSFERRED.
- Destination principal is the remaining principal, not the original principal, so prior principal repayments are not double-counted.
- Historical bank movements stay in the source organization and are not reposted into the destination's bank/cash ledger.
- A transfer can be reversed only if the destination loan has no posted principal repayment or paid interest. Reversal restores the source loan to ACTIVE and marks the destination loan TRANSFER_REVERSED; audit/history rows are retained.
- Transferred source loans cannot be edited, repaid, or have historical principal repayments reversed until the loan transfer itself is reversed.
- Transfer authorization checks destination organization mapping and keeps LIVE and TEST separate.

## Accounting note
This workflow transfers the outstanding loan obligation and servicing responsibility; it does not move historical cash transactions or historical interest expense into the destination. The transfer-history snapshot preserves them for audit. If statutory reporting requires formal inter-company due-to/due-from journal entries or lender novation documentation, those should be recorded/approved separately according to the company's accounting policy.

## Verification
- Regression source checks are provided as `npm run check:funding-transfer`.
- TypeScript/TSX syntax transpilation checks passed for all changed TS/TSX files in the packaging environment.
- SQLite financial-schema/SQL smoke checks and ZIP integrity checks are reported separately by the release verification status.
- A full Next.js production build and end-to-end tests against the user's actual SQLite and PostgreSQL/Neon databases must be run in the target environment before production use.
