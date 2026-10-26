# SOLIVY Finance v2.5.76 — Automatic Offline/Online Merge

Baseline: SOLIVY-Finance-v2.5.70-QUALITY-DEDUCTION-RATE.

## Changes
- Preserves the baseline business features and adds the existing safe company-bound sync and persistent ID mapping changes.
- Merges independent field edits when both devices changed a row after the same base version.
- For the same field changed differently, selects a deterministic value so devices can converge and stores both local/incoming values in `sync_conflict_history` for audit.
- Uses persistent identity mappings for colliding integer IDs and remaps declared foreign keys when mappings are known.
- Conflict-resolution pushes for new inserts now pass through the same ID reconciliation path rather than blindly overwriting a destination row with a colliding key.
- Existing transaction boundaries and foreign-key enforcement are retained; foreign keys are not disabled.

## Important limits / verification status
This is a source candidate, not a production-verified release. Source checks pass, and ZIP integrity is checked. A full dependency install, Next.js production build, and live SQLite/Neon integration test have not been run in this environment. Before production, back up both databases and test with a copy of the actual offline and online databases, including party, purchase, payment, ledger, delete/edit, and reconnect scenarios.

## Audit behavior
`sync_conflict_history` stores each field where both sides changed the same field differently: base value, local value, incoming value, record key, event ID, and timestamp. The live row uses a deterministic winner to prevent ping-pong; the alternate value remains in the audit table.
