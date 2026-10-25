# SOLIVY Finance v2.5.74 — Safe company-bound sync

## Fixes
- Fixed singleton tables with schema constraints such as `company_settings.id CHECK(id=1)` are no longer treated as ordinary colliding records by the persistent ID mapper. Incoming keys are normalized to the schema-required singleton ID and are merged by the existing conflict-safe company-settings reconciliation logic.
- The sync route performs token authorization and verifies the selected local organization name against the token-authorized remote organization before pushing any pending events. Company IDs may differ between installations.
- The sync batch remains transactional: a failed event rolls back the current batch rather than partially applying financial changes. The error is returned for review; no event is silently discarded.

## Validation
- Source regression checks added for singleton key guard and company identity preflight.
- Must run on staging with backups for both SQLite offline and online/Neon deployments. Full production integration is not claimed by this source package alone.
