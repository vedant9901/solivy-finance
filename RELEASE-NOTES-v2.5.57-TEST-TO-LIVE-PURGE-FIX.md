# SOLIVY Finance v2.5.57 — TEST-to-LIVE after Purge Fix

## Fix
- TEST-to-LIVE promotion no longer treats preserved `company_settings` rows as financial records that block promotion.
- TEST `company_settings` values continue to replace matching LIVE settings during the promotion transaction.
- Promotion still refuses to proceed if any other protected table contains rows; the error identifies the populated tables.
- The existing purge backup behavior is unchanged.

## Safety note
This change does not force-overwrite a non-empty LIVE database. Back up LIVE before using purge or promotion, and verify company and environment selection.

## Verification status
Source-level logic updated. Run the project's source/security/database checks and a controlled TEST-to-LIVE acceptance test against disposable databases before deploying to a customer's financial data.


## Files changed
- `app/api/test-to-live/route.ts` — keeps the LIVE safety guard for all protected tables but excludes only `company_settings`, which the purge intentionally preserves and promotion intentionally replaces. The rejection message lists populated blocking tables.
- `scripts/check-test-to-live-purge-fix.mjs` — adds static regression checks.
- `package.json` — version 2.5.57 and `check:test-to-live` script.
