# SOLIVY Finance v2.5.69 — Sync Company Settings Fix

## Fix
- Fixes the offline AKSH ENTERPRISE (Company ID 2) to online AKSH ENTERPRISE (Company ID 3) sync conflict where online `company_settings.id=1` still contains the schema placeholder `entity_name='SOLIVY'` and empty JSON document settings.
- The sync exchange resolves the destination organization's name from the authenticated pairing's company ID before reconciling the initial `company_settings` row.
- Replaces the exact `SOLIVY` schema placeholder only when the incoming `entity_name` matches that authenticated destination organization's master name. It does not broadly overwrite custom names or another organization's settings.
- Treats `{}` in document-settings JSON columns as an empty placeholder so non-empty incoming document configuration can be merged safely.
- Applies the same merge logic when downloaded sync events are applied on the offline side.
- Keeps conflict protection for non-empty, genuinely different values and preserves LIVE/TEST separation.

## Verification
- `npm run check:sync-company-settings`
- `npm run check:sync`
- `npm run check:database-bridge`
- `npm run check:security`
- `npm run check:multicompany-sync`

A complete Next.js production build and live Neon end-to-end sync must still be run in the deployment environment before promoting this build to LIVE.
