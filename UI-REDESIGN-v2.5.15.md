# SOLIVY Finance v2.5.15 — Minimal UI Redesign Candidate

## Design direction
- Minimal white workspace with subtle gray borders.
- Teal used as a restrained primary action/accent color.
- Compact accounting tables on desktop; existing responsive card tables on mobile.
- Consistent form control sizing, focus states, button hierarchy, and readable numeric figures.
- Reduced visual noise: removed gradient/shimmer treatments, excessive shadows, and animated card entrances.
- Existing `react-icons` dependency retained.

## Scope and preservation
This change is based on the v2.5.14 source lineage. It intentionally changes only the shared visual system (`app/globals.css`), two dashboard decorative classes (`app/page.tsx`), package version metadata, and this documentation. It does not intentionally change API routes, database schema, financial formulas, authentication, permissions, session configuration, or SQLite storage.

Tailwind responsive layout classes already used by the application (`sm:`, `md:`, `lg:`, `xl:`) are retained. Shared CSS supplies consistent visual tokens and control styling; it is not intended to replace responsive layout utilities.

## Static verification performed
- TypeScript/TSX parse audit: 47 files; passed.
- Security audit: all 15 checks passed.
- Import/schema audit: all 6 checks passed.
- Relative import audit: 55 source files; 0 unresolved relative imports.
- ZIP archive integrity: to be recorded after packaging.

## Not yet verified
A full `npm install` timed out in the build environment, so `next build`, browser interaction tests, and offline SQLite end-to-end workflow tests could not be completed. This package must not be described as production-build verified until those tests pass on a dependency-complete environment.

## Required release gate
1. `npm install`
2. `npm run check:source`
3. `npm run check:security`
4. `npm run check:import`
5. `npm run build`
6. Start the app in production mode and verify login/logout, LIVE/TEST switching, company selection, purchase save/edit, payment save/edit/allocation, reversal permissions, backup/restore, and PDF generation against a disposable test database.
7. Confirm an offline run after dependencies are installed and verify data persists after restarting the app.
