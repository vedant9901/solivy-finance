# SOLIVY Finance v2.6.12 — Financial Repair Review Gate

## Fix
- Previously every account transaction with `reference_type = REVERSAL` or narration containing `reversal of finance receipt` was permanently counted as suspicious. The balance adjustment endpoint used the same unfiltered predicate, so the repair gate could never be cleared by reviewing entries in the UI.
- Added `financial_repair_reviews`, scoped by transaction, mode, and company. Admin can mark an entry as reviewed as a legitimate reversal with a reason and explicit confirmation phrase.
- Diagnostics and the adjustment gate now exclude only entries that have been explicitly reviewed as legitimate. Original ledger transactions are never edited or deleted by this review action.
- Review action creates a pre-change backup and an audit log entry. Actual duplicates must not be marked legitimate; investigate and correct actual duplicate accounting entries separately.

## Safety
- Review only after verifying the original receipt, reversal, linked receivable, and bank statement. Marking an entry reviewed is an attestation, not an accounting correction.
- The build ZIP is source-packaged; full production build and live-database regression tests have not been executed in this environment.
