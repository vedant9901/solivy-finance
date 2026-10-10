# SOLIVY Finance v2.5.18 — Responsive dashboard patch

## Changes
- Fixed financial KPI cards so currency values do not wrap in the middle of digits. Purchase summary cards use a three-column responsive grid at tablet/desktop sizes and two columns on small screens.
- Dashboard OPEN FUNDING and Manage Accounts actions now use the React tab state callback instead of changing `location.hash`, which did not switch the visible module.
- Added the supplied SOLIVY wordmark to desktop/mobile brand areas and generated favicon assets.
- Added an on-screen display currency preference (INR default; USD/EUR/AED optional). This is formatting only and does not convert stored values. Accounting documents remain INR; this is intentionally disclosed to avoid silently changing accounting semantics.
- Existing SQLite, financial API routes, auth/session, roles and permissions were not intentionally changed.

## Verification
- Source has been patched and static checks should be run with the included scripts. A full production build and end-to-end workflow tests were not executed in this packaging environment because project dependencies are not installed here. Do not treat this ZIP as production-certified until `npm run build` and workflow checks pass on a dependency-complete environment.
