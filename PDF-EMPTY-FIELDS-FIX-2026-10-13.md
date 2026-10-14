# SOLIVY Finance v2.5.23 — PDF Empty Fields Fix

## Change
- The purchase/third-party bill PDF metadata grid now creates rows only for fields with actual values.
- Labels such as `Dated`, `Invoice No.`, `Sample No.`, and `Mode/Terms of Payment` are omitted when their corresponding value is empty.
- Empty metadata rows are not drawn; remaining metadata rows are distributed within the existing metadata area.
- The existing third-party invoice-number source and optional deductions behavior are preserved.

## Checks run for this change
- `node scripts/check-source.cjs` — passed (57 files parsed by the repository source checker).
- `node scripts/check-import-schema.mjs` — passed (6 import integrity checks).
- `node scripts/check-security.cjs` — passed (static source checks).
- `node scripts/license-tool.cjs self-test` — passed (license signing/verification self-tests).
- Full `npm run build` — not run: `node_modules` is not installed in this environment.
- PDF rendering/end-to-end test and live Vercel/Neon tests — not run.

This is a source candidate; do not interpret static checks as proof that every production flow is error-free.
