# SOLIVY Finance v2.5.16 — Premium Dashboard UI Candidate

## Visual changes
- Restored a premium navy desktop sidebar with icon-led navigation and a teal active-menu highlight.
- Added distinct KPI accents/icons, richer chart bars, and a dark business-pulse summary card.
- Kept compact sortable tables on desktop and responsive record cards on mobile.
- Removed sticky positioning from the mobile module selector and page header to prevent stacked sticky organization controls from cluttering the viewport.
- Added a compact mobile brand row and reduced duplicate LIVE/TEST indicators.
- Kept Tailwind responsive utility classes, existing React Icons dependency, and existing page/module logic.

## Non-UI logic
No intended changes to finance calculations, API routes, SQLite persistence, login/session handling, or role permissions.

## Verification status
- `node scripts/check-source.cjs`: passed (47 TS/TSX files parsed by project check).
- `node scripts/check-security.cjs`: passed.
- `node scripts/check-import-schema.mjs`: passed (6 import/schema checks).
- ZIP integrity: to be verified after packaging.
- Full `npm install` timed out in the build environment. Therefore `next build` and end-to-end finance workflows have NOT been verified. This is a UI candidate, not a production-final release.
