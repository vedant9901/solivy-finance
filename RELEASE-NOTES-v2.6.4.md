# SOLIVY Finance v2.6.4 — Executive Dashboard & Purchase UX

## Baseline
- Application modules and backend based on `SOLIVY-Finance-v2.5.81-GODOWN-SAUDA-FIX`.
- Dashboard component and dashboard-specific styles ported from `SOLIVY-Finance-v2.6.0-EXECUTIVE-DASHBOARD`.

## Changes
- Removed Group MIS as a navigation destination; consolidated multi-company analytics remains available inside the executive dashboard.
- Removed Bank Statement Import from navigation.
- Reordered the main navigation and added category labels/dividers on desktop and mobile.
- Purchase / Sample uses the v2.6.0 searchable/sortable register and responsive add/edit modal; includes purchase note field and retains PDF/reverse actions.
- Shared table rows use unique record/index keys, 15 rows per page, direct page selection and previous/next navigation. Mobile cards no longer repeat a sort selector inside every card.
- Masks account numbers, IFSC, PAN/TAN, GST identifiers, contact, phone and email values in common table rendering by default.
- Removed email and WhatsApp actions from the application UI.
- Normalized API URLs so `company_id` is set once instead of appending a duplicate or blank parameter (e.g. `/api/data?mode=LIVE&company_id=&company_id=...`).
- Purchase note is sent in payment-advice allocation data and rendered when payment-advice settings allow notes.

## Validation
- `scripts/check-source.cjs`: passed (84 TypeScript files parsed; source/dependency/Tailwind audit).
- `scripts/check-database-bridge.mjs`: passed (60 API route files).
- `scripts/check-test-to-live-purge-fix.mjs`: passed (5/5).
- `scripts/check-security.cjs`: one assertion fails because the menu label was changed from “License Management” to “License”; remaining reported checks passed.
- Full Next.js production build not run in this environment; dependency installation was not performed.
- API response-time benchmark not run against the deployed online database. The duplicate `company_id` request construction was fixed, but `/api/data` and `/api/login-companies` latency must be measured on the target environment before claiming performance improvement.
