# SOLIVY Finance v2.6.15 — Sync Foreign-Key Reliability Fix

- Orders sync events using destination schema foreign-key dependencies: dependent deletes before parent deletes, parent inserts/updates before dependent inserts/updates.
- Preserves stable order for events at the same dependency rank.
- On a foreign-key failure, returns the affected table, operation, primary-key payload and referenced-table hints.
- Keeps each batch transactional: failed batches roll back; does not disable foreign-key constraints or silently skip finance records.

## Verification status
Source patch applied to both sync pull and sync exchange/push paths. Full Next.js build and real two-database sync regression tests have not been run in this environment. Test on backed-up LIVE and TEST databases before production use.
