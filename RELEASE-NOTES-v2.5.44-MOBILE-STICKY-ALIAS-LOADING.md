# SOLIVY Finance v2.5.44 — Mobile Header and Party Alias Loading

## Changes
- Only the compact mobile brand row (menu icon + SOLIVY logo/name + mode pill) sticks to the top on mobile.
- The company/environment page header is no longer sticky on mobile.
- The mobile navigation drawer/backdrop layer above the sticky brand row.
- Party Aliases now loads party and third-party master lists from `/api/party-aliases`, the same organization/environment-scoped API that supplies alias rows, instead of relying on `/api/data` response fields that can be permission-filtered or empty.
- Normalizes the party list response's `party_id`/`party_name` shape as well as `id`/`name`, so Party Master records populate the selector/list even when no alias exists yet.

## Verification
- Source edits reviewed; package JSON parsed successfully.
- ZIP archive integrity checked after packaging.
- Full Next.js production build and live SQLite/PostgreSQL end-to-end checks are not claimed from this environment.
