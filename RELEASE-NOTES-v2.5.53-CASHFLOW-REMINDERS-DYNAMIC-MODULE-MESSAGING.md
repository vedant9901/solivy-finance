# SOLIVY Finance v2.5.53 — Cash-flow reminders and module access messaging

## Changes
- Added overdue vendor payable query to the dashboard API, with due date, unpaid amount and days overdue.
- Added a dedicated Overdue Payables dashboard table and total, separate from overdue receivables.
- Clarified that incoming transfer acceptance appears on the destination organization's Inter-Company Transfers screen for PENDING transfers in the matching environment.
- Corrected misleading module-lock messaging: it now points to organization/user Menu access and session/company refresh rather than incorrectly claiming the feature is not in the license.

## Existing transfer behavior and limitations
- Online incoming transfers can be accepted or rejected by the destination organization; source deletion requires receipt confirmation.
- The existing transfer API requires source and destination to use the same LIVE/TEST environment. Selecting a different destination environment during a transfer is NOT implemented in this release.
- Purchases with payment allocations still cannot be safely moved as a multi-type bundle; this release does not claim to fix that case.

## Validation
Source/security/database-bridge/transfer/dashboard source checks passed in this environment. A full Next.js production build and live SQLite/PostgreSQL integration test were not run.
