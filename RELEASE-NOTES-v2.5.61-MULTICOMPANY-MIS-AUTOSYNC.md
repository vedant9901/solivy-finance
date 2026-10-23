# SOLIVY Finance v2.5.61 — Multi-Company MIS, Party Mapping and Background Sync

## Fixed / Added
- Inter-Company Transfer destination organizations are loaded from a dedicated authenticated endpoint. Options are restricted to active organizations where the signed-in user has access to the current LIVE or TEST environment; the API rechecks authorization when sending.
- Added Group MIS for mapped organizations: all-time cash inflow/outflow/net, current-month cashflow, organization-wise totals, and top parties by ledger transaction volume.
- Added mapped-company party mirrors to the local party picker. Source party names and tax/contact master data are copied into the current organization's party master with source-company identity. Opening balances and ledgers are not copied. Mirrors are labeled and read-only; edit the original party in its source organization.
- Added application-wide automatic sync runner with a separate saved configuration for each local organization and environment. When auto sync is enabled and the app is open, it runs immediately on configuration/connection restoration and then every 10 minutes from the application root; the Sync screen does not need to remain open. The browser/app must still be running.
- Fixed sync settings persistence so initial component rendering does not overwrite saved settings before they load.
- Added regression source checks and wired them into the client release builder.

## Design notes
- Group MIS values are summed as stored. No FX conversion is applied; consolidated totals are meaningful only when included organizations use the same currency.
- Party mirrors are for selecting the same external party in a mapped company's transaction forms. Their opening balances are set to zero because balances belong to the source company's books. Source party master changes are refreshed on data loads without generating repeated sync events when the source fields are unchanged.
- Automatic sync is browser-runtime polling, not a server daemon. It does not run after the browser/app is closed or the operating system suspends the process.

## Verification performed for this build
- TypeScript/TSX syntax transpilation audit.
- Source/security/sync/transfer/user-company-conflict/Money Out/TEST-to-LIVE/license checks.
- New multi-company/sync regression source checks.
- SQLite schema execution, mapped-party insert SQL, and cashflow aggregation SQL tested with Python's SQLite engine.
- Full `npm install` timed out in the build environment, so a complete `npx tsc --noEmit`, Next.js production build, and end-to-end database/browser tests could not be completed here. Run the release builder on a machine with dependency installation available before production rollout.
