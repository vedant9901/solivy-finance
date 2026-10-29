# SOLIVY Finance v2.6.18 — Account Transaction Parent Sync Fix

## Issue addressed
A sync batch can fail with HTTP 409 / `FOREIGN KEY constraint failed` for `account_transactions.account_id -> company_accounts.id` when the child transaction is queued but the parent account has no pending sync event.

## Source change
- Before pushing pending changes, explicitly include the source database's `company_accounts` row for each outgoing `account_transactions` record.
- Queue the account parent before dependent rows; normal foreign-key ordering and destination ID mapping remain enabled.
- Parent rows are never fabricated. If the referenced account is missing in the source database, sync must remain blocked for repair rather than create a fake bank account.
- Existing conflict handling, transaction rollback, and foreign-key constraints remain enabled.

## Deployment
Deploy the same release to **both** offline and online sync peers, then restart/redeploy both services and retry sync. This change is in the sync sender path; an older peer may still send child rows without parent snapshots.

## Verification limits
Static source check and ZIP integrity only. Full Next.js production build and two-peer sync regression tests have not been run. Test against backups first.
