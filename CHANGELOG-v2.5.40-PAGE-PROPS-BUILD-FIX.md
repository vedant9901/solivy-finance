# SOLIVY Finance v2.5.40 — Page Props Build Fix

## Fix
- Moved the Party Aliases interactive panel out of `app/party-aliases/page.tsx` into `app/components/PartyAliasesPanel.tsx`.
- Replaced the route file with a valid Next.js App Router page that redirects direct visits to `/?tab=party-aliases`.
- Updated the main finance workspace to render the panel from the component folder and select the requested tab on direct navigation. This keeps the existing workspace sidebar/drawer and company/mode context.
- Updated package version to 2.5.40.

## Verification
- `scripts/check-source.cjs`: PASS (65 TypeScript/TSX files parsed).
- Full `npm install` timed out in the build environment, so `next build` and dependency-backed type checking could not be completed here. A bare global `tsc --noEmit` run reports missing project dependencies/types because `node_modules` is not installed; this is not a clean full type-check.
- No claim is made that all APIs or SQLite/PostgreSQL end-to-end flows have passed regression testing.
