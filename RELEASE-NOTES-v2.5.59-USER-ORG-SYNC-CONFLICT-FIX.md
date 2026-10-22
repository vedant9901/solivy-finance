# SOLIVY Finance v2.5.59 — User, Organization Access, and Sync Conflict Review

## Changes
- Added administrator-only user deletion from Administration → Users. The primary administrator is protected; the signed-in account cannot delete itself; the last active administrator cannot be deleted. User-company assignments and password-reset tokens are removed with a deleted user. Accounting records are not removed.
- Added explicit LIVE and TEST access assignment for existing active users when creating a new organization. Access is opt-in per user and per environment; existing users are not silently granted access to every organization. The creating administrator retains access to both environments.
- Exposed the primary-admin marker in the admin data response so the UI correctly labels the protected account.
- Added structured sync conflict details (table, primary key, current row, incoming row, base version, and field-level conflicts) to HTTP 409 responses, and added a side-by-side conflict review panel. For initial `company_settings` INSERT collisions only, SOLIVY merges non-empty fields when there are no disagreements, preserving the latest `updated_at` and earliest `created_at`; it emits a follow-up change so both sides converge. If two non-empty values disagree, the batch remains blocked for review. Accounting tables are never auto-merged.
- Added source checks for these protections.

## Validation
- `node scripts/check-user-org-conflicts.cjs`: PASS
- `node scripts/check-sync.mjs`: PASS
- `node scripts/check-security.cjs`: PASS
- `node scripts/check-source.cjs`: PASS
- `node scripts/check-test-to-live-purge-fix.mjs`: PASS
- Full `next build`: NOT VERIFIED in the packaging environment because dependency installation timed out before `node_modules` was created. Run `npm install` and `npm run build` on the development PC before distributing.

## Important
Back up LIVE and TEST databases before deployment. Review the existing and incoming versions for every 409 sync conflict and correct the intended side before retrying.
