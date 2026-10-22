# SOLIVY Finance v2.5.52 — Executive Dashboard & Linked Posting Transfer Fix

## Dashboard
- Turnover now derives from posted financing receivable bills and the linked purchase's posted status. Financing receivables themselves use OPEN/RECEIVED/CLOSED lifecycle states, so treating their own status as POSTED incorrectly filtered them all out and showed zero.
- Current and previous financial year turnover, YoY growth, average billing value, monthly comparison, and top five parties use bill date and receivable amount.
- Separate book margin (booked discount + other-charge profit divided by booked receivable value) from realised margin (profit allocated to received amounts less posted interest, divided by received amount).
- Funding available is shown as active recorded loan principal plus cumulative realised net profit; bank/cash balance remains a separate reference figure.
- Sales, supplier payments, other receipts and withdrawals are presented separately to avoid treating cash movement as turnover.

## Transfers
- Transfer payloads now include linked account transaction rows, matching ledger rows and payment bank matches for the selected posted records.
- Destination acceptance remaps account/party references and imports linked rows in the same database transaction as the main record.
- Source removal checks the acceptance receipt and verifies linked rows have not changed, then deletes linked postings and the source record in one transaction while keeping the transfer audit log.
- Existing safety restriction for purchases/payments with payment allocations remains: those allocation bundles are not yet automatically expanded into cross-type purchase/payment bundles.

## Verification status
- Source parsing audit passed.
- Security source audit passed.
- Database bridge source audit passed.
- Import schema checks passed.
- Dashboard metric source checks: 13/13 passed.
- Transfer source checks: 17/17 passed.
- License signature self-tests passed.
- Full Next.js production build and live SQLite/PostgreSQL integration tests were not run because dependency installation timed out in the build environment. This package is a candidate for TEST-environment validation, not a production-certified release.
