# SOLIVY Finance v2.5.72 — Persistent Sync ID Mapping

## Purpose
Fix safe initial synchronization when independently populated online/offline databases contain different records with the same integer primary key. Existing records are preserved; the incoming record is assigned a new destination ID and its source identity is persisted.

## Changes
- Adds `sync_id_mappings`, scoped by source device, table and source primary key.
- Adds `sync_meta.remote_device_id` to retain the paired peer identity.
- Reconciles incoming INSERT primary-key collisions for single-column integer `id` tables by assigning an unused destination ID, without deleting or overwriting the existing row.
- Rewrites declared foreign-key references when a persistent mapping exists.
- Returns newly created mappings to the sending peer and stores the inverse mapping locally.
- Exchanges mapping updates on later sync requests, including when there are no pending data events.
- Excludes sync metadata/mapping tables from business-data synchronization triggers.
- Preserves the existing 409 conflict protection for non-insert updates/deletes and unresolved collisions.

## Client workflow
1. Back up both offline and online databases.
2. Deploy the same release to both ends and restart the application.
3. Open Workspace → Sync and run Test Connection.
4. Click Sync Now. For the reported collision, the existing `test` party stays in place and incoming `VR HUF` is assigned a new destination ID if its table has a single integer `id` primary key.
5. Run Sync Now again to confirm idempotent behavior and verify party-linked purchases/payments/ledger entries.

## Safety notes
- No row is deleted by the ID-collision reconciliation path.
- Only declared SQLite foreign keys are automatically remapped. Columns that merely behave like foreign keys but lack schema constraints require explicit schema mapping before being safe.
- Unique business-key conflicts (for example duplicate unique invoice/sample numbers) remain conflicts; they are not silently merged.
- This package is a source candidate. The environment did not have dependencies installed and dependency installation timed out, so a full Next.js production build and live PostgreSQL/Neon integration test were not completed in this session. Do not treat this ZIP as production-verified until those checks pass against backups/staging databases.
