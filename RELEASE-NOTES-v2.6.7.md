# SOLIVY Finance v2.6.7 — Receipt Reversal Fix

- Financing-receivable reversal processes all linked finance receipt bank credits across accounts rather than assuming there is exactly one receipt transaction.
- Reversal posts matching bank debits and reopens the receivable inside a transaction.
- Original receipt credit rows are marked `FINANCE_RECEIPT_REVERSED` after reversal so a later receipt/reversal cycle cannot reverse the same historical bank credits twice.
- The existing receipt records and reversal entries remain in the account transaction history.

## Validation
- ZIP integrity checked after packaging.
- Full Next.js production build and live database reversal tests have not been run in this environment. Back up LIVE data and test with a copy/TEST company first.
