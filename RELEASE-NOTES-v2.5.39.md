# SOLIVY Finance v2.5.39 — Alias data and navigation correction

## Included in this build
- Party Aliases is rendered inside the existing application shell so the normal desktop sidebar/mobile drawer remains present.
- Party list is sourced from `/api/data` rather than inferred from alias rows. Parties without aliases are shown as records with an optional alias.
- Party and third-party tabs use the selected organization and LIVE/TEST mode passed from the main app.
- Alias rows and third-party records show names and contact data rather than organization names.
- Alias CSV export added.
- Existing party alias API conflict checks remain in place.

## Accounting migration recommendation
Use a staged cutover:
1. Import party/supplier/customer masters and aliases.
2. Import opening balances as of the cut-off date, plus bill-wise outstanding balances when bill aging is needed.
3. Optionally import historical purchases/payments/receipts with source reference and duplicate key; don't import both opening balance and the same full history into balances.
4. Import each bank statement to a staging/reconciliation queue. Match by date, amount, reference and account; never auto-post a duplicate book voucher.
5. Reconcile opening and closing bank balances and party control totals before enabling LIVE use.

## Not included / not certified in this release
This build does not implement a complete mid-year migration wizard or the requested commodity Sauda workflow. Those require schema/API/UI work and end-to-end tests across SQLite and PostgreSQL. The existing regression checklist remains required.

## Checks run in this environment
- `scripts/check-source.cjs`: passed (64 files)
- `scripts/check-import-schema.mjs`: passed (6 checks)
- `scripts/check-database-bridge.mjs`: passed (46 API route files)
- `scripts/check-security.cjs`: passed
- `scripts/license-tool.cjs self-test`: passed
- ZIP integrity: checked separately
- `npm install`: timed out in this environment; full TypeScript and Next.js production build not verified.
