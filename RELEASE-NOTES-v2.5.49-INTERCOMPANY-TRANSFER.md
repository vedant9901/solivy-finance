# SOLIVY Finance v2.5.49 — Inter-Company Transfer (Initial Integration)

## Included
- Adds an Inter-Company Transfers navigation module.
- Supports transfer requests for purchases, payments, Money In, account movements/withdrawals, interest payments, sales, and funding loans.
- Requires source user to be mapped to both source and destination organization, with environment-specific access.
- Destination organization explicitly accepts or rejects each pending transfer.
- Supports JSON transfer-package export/import for offline handoff, plus acceptance receipt export/import.
- Uses party/account name mapping at destination; it does not silently reuse source numeric IDs.
- Rejects duplicate transaction references and incompatible LIVE/TEST transfers.
- Records acceptance and source-removal events in audit logs.
- Source removal occurs only after a receipt is confirmed; records are retained while pending or rejected.
- Blocks transfers where known ledger, bank/cash posting, payment allocation, or bank-match dependencies would otherwise be orphaned.

## Safety and limitations
- This is an initial integration, not a fully validated accounting migration engine. Transactions with dependent ledger/bank postings are intentionally blocked rather than partially transferred. Those linked records need a bundled transfer implementation before those cases can be enabled.
- Offline packages and receipts are user-carried files. Protect them and exchange them only through trusted channels. The receipt workflow is not a substitute for a cryptographic organization-to-organization trust service.
- The current transfer type list does not yet cover every SOLIVY table, all attachments, every supporting document, or every linked allocation. Do not treat this release as supporting literally every record type.
- A complete Next.js production build and end-to-end database test could not be run in this environment because dependency installation timed out. The source-level TypeScript invocation is inconclusive while project dependencies/types are unavailable.
- Before production use, test online with PostgreSQL/Neon and offline with separate client installations, covering acceptance/rejection, duplicate references, missing party/account mapping, LIVE/TEST isolation, receipt tampering, rollback, audit entries, and linked-ledger cases.

## Bulk selection update
- Added a header-level **Select all** checkbox for eligible posted records shown in the selected module.
- Selection is capped at 500 records per transfer; non-posted rows are disabled.
- Added selected-count feedback and a **Clear selection** action.
- Source-level transfer checks are available with `npm run check:transfers`.

## Verification status for this package
- PASS — source parser audit (66 files).
- PASS — security/source smoke checks.
- PASS — import schema checks (6 checks).
- PASS — PostgreSQL/SQLite bridge source audit (47 API route files).
- PASS — license signing self-test.
- PASS — inter-company transfer static checks (15 checks).
- BLOCKED — dependency installation timed out in this environment; full `next build` and live API/database integration tests could not be completed.
- NOT CERTIFIED FOR PRODUCTION — transfer cases with dependent ledger/bank postings or allocations are intentionally rejected. Offline receipt files are carried between installations and must be exchanged only through a trusted channel; this package does not implement a cross-installation cryptographic trust registry. Keep verified backups and test with copied databases before real financial use.
