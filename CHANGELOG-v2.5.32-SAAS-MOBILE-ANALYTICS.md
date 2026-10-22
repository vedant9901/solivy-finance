# SOLIVY Finance v2.5.32 — SaaS UI and Mobile-First Analytics

## Scope
- Uses the v2.5.30 Offline/Online Database Fix as the baseline.
- No Sauda module is added to navigation or active workflows.
- Replaces the mobile module dropdown with an accessible slide-in navigation drawer.
- Adds a clear dashboard introduction, high-frequency quick actions, section hierarchy, and responsive metric/chart layouts.
- Keeps financial KPI values sourced from the existing `/api/data` response instead of introducing new client-side financial calculations.
- Corrects the dashboard's upcoming-payables aggregation so only POSTED payments reduce the amount due.

## Analytics semantics
- Existing API-derived purchase, payment, outstanding, profit and trend calculations remain the source of truth.
- Pending purchase due amounts now exclude allocations from non-POSTED payments.
- This UI release does not claim that all legacy profit/date-bucketing formulas have been independently audited. Those require separate accounting-rule and database regression tests before production certification.

## Verification status
- Source ZIP integrity checked after packaging.
- TypeScript/Next.js build and live SQLite/PostgreSQL integration tests must be run before production release; this changelog does not claim those checks passed.

## Checks run in this environment
- `scripts/check-source.cjs`: PASS (62 files checked).
- TypeScript parser syntax check for changed TSX and API route: PASS.
- `scripts/check-database-bridge.mjs`: PASS (45 API route files use the bridge).
- `scripts/check-security.cjs`: PASS.
- `scripts/license-tool.cjs self-test`: PASS for Ed25519 signing/verification.
- `scripts/check-env.mjs`: not completed because required runtime configuration is absent in this environment.
- `scripts/check-import-schema.mjs`: FAIL on its existing “Import route exists” assertion; other listed import checks passed. This is not changed by this UI-focused release.
- `npm install` timed out in this environment; therefore a full Next.js production build and runtime regression could not be completed here.
