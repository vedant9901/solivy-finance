# SOLIVY Finance v2.5.19 — Menu Access & KPI Cards

## Changes
- Added persistent `menu_access` JSON field to `admin_users`, with automatic SQLite migration for existing installations.
- Admin User Management now shows every module with its stable menu ID and an access checkbox. Unchecked menus remain visible with a lock indicator and cannot be opened from the application navigation.
- The Administration section remains ADMIN-only and is not part of the lockable module list. ADMIN role always has access to all modules.
- Existing users with no saved menu policy default to all existing modules to avoid unexpectedly locking out current users.
- Login response includes menu access and the UI stores it for the current browser session.
- Removed decorative KPI trend icons and updated KPI value typography to use tabular numerals and responsive sizing.

## Verification performed
- `node scripts/check-source.cjs`: passed (47 TypeScript/TSX files parsed).
- `node scripts/check-security.cjs`: passed.
- `node scripts/check-import-schema.mjs`: passed (6 checks).
- ZIP archive integrity: checked after packaging.

## Important limitation
A full `npm run build` and end-to-end login/permission workflow test have not been run in this environment. Menu locks currently control client-side module navigation; this patch does not add per-menu API authorization. Existing server-side role/session permissions remain in place. Do not treat the archive as production-certified until `npm run build` and role-based tests pass.

## Locked module preview update
- Selecting a locked module now opens a responsive preview dialog instead of only showing a brief toast.
- The dialog contains an illustrative screenshot-style workspace preview, plain-language module purpose, key capabilities, stable menu ID, and the message: "This module is not included in your current plan. To learn about availability or upgrade options, please contact the SOLIVY Team."
- Locked modules remain inaccessible; closing the preview returns to the current workspace. Administrator access behavior is unchanged.
- The preview is illustrative and does not display live financial records.
