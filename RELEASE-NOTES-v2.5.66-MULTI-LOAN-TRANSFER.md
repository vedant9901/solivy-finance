# SOLIVY Finance v2.5.66 — Multi-Loan Inter-Company Transfer

- Inter-Company Data Transfer now supports selecting multiple ACTIVE funding loans, including Select all eligible loans (up to 500 visible/selected records).
- Selected loans are sent sequentially through the existing dedicated `/api/funding/transfer` endpoint. The generic data-package workflow remains disabled for loans.
- Each loan keeps the existing outstanding-principal calculation, repayment-history snapshot, audit records, concurrency guard, and reversal safeguards.
- Results report the number of successful transfers and list per-loan failures. Failed loan selections are retained for retry; the list refreshes after processing.

## Verification

Source-level regression checks and syntax transpilation are run for this package. Full Next.js production build and end-to-end database tests must still be run in the customer's Windows/Neon environment before LIVE deployment.
