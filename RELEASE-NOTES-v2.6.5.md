# SOLIVY Finance v2.6.5 — Receivables Reversal, TDS Outstanding & API Read Performance

## Changes
- Administration & Sync navigation group now contains only Online / Offline Sync, Backup / Restore, and Secondary Backup. Inter-Company remains a separate module.
- Added a narrowly-scoped legacy data repair for financing receipts where `received_amount` was incorrectly saved as net bank credit and the exact TDS amount equals the remaining balance. It repairs only when the linked single FINANCE_RECEIPT bank credit matches `net_received`; the gross receipt is set to the receivable amount and status becomes RECEIVED.
- Financing receipt reversal uses the net bank credit amount and records the provided reason in the reversal narration. Reversal errors are now displayed to the user. Reversal supports multiple receipt credits by creating a debit for each original bank credit, including receipts into different accounts; it stops if no linked receipt credit exists.
- Cross-company party mirroring no longer runs on every `/api/data` request. It runs only when `sync_parties=1` is explicitly requested; ordinary dashboard/data loads avoid this cross-company read/write loop. Authorized source IDs remain available for party visibility filtering.

## Validation status
- Source-level checks and ZIP integrity are run during packaging.
- Full Next.js production build and deployed online API latency tests are not claimed unless run against the target environment.
- No live database was modified by packaging; the narrowly-scoped repair runs only when the relevant receivables endpoint is requested in the target app.
