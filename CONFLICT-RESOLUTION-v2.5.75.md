# SOLIVY Finance v2.5.75 — per-record sync conflict resolution

## Client workflow
- Workspace → Sync shows conflict details and offers per-record actions: Push this device version, Accept online version here, or Defer.
- Push/accept actions require confirmation in the UI. Defer changes no records.
- Conflict responses include the event and phase (`push` vs `pull`) so the chosen side is interpreted in the correct direction.
- Forced remote writes are authorized by the existing pairing token/company/environment, validate table and primary-key schema, run in a transaction, and are recorded in `sync_resolution_log`.
- Local accepted versions are written with trigger suppression, recorded in the same audit table, and resolved event markers prevent immediate replay conflicts.
- Missing/deleted-record conflicts are intentionally blocked; they require a dedicated delete/recreate workflow.

## Caution / verification
This is a source candidate. A full dependency install, Next.js production build, and live two-database integration test are still required before production use. The conflict actions overwrite only the selected row; for financial tables such as purchases/payments, verify dependent ledger/reversal records before confirming. Back up both databases first.
