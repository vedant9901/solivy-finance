# SOLIVY Finance v2.6.16 — Financial Repair Sync Schema Fix

## Fix
- Sync exchange now creates/ensures `financial_repair_reviews` on the receiving company/mode database before processing incoming sync events.
- This resolves the specific case where a peer has never opened Financial Repair and therefore does not yet have the table, causing `Unknown synchronized table: financial_repair_reviews` and HTTP 409.
- Existing financial rows are not deleted or overwritten by this schema initialization.
- Foreign-key constraints and conflict protections remain enabled.

## Verification
- Static source check: verified schema initialization is called immediately after selecting the company/mode database in sync exchange.
- ZIP integrity: verified after packaging.
- Full Next.js production build and two-peer online/offline sync regression tests have not been run in this environment.
