# SOLIVY Finance v2.5.23 — PDF Metadata Options

## Changes
- Purchase and third-party bill PDF metadata is built only from non-empty label/value pairs.
- Empty metadata rows are not rendered; the metadata box height follows the actual row count.
- Document Settings now includes `Combine Sample No. & Date` for both Commercial Bill and 3rd Party Bill.
- The new option defaults OFF for existing settings. When enabled and Sample No. is enabled, the PDF prints `Sample No. & Date` together; when disabled, Sample No. and Dated remain separate fields.
- Payment terms and reference fields respect their existing document settings.

## Checks run
- `node scripts/check-source.cjs` — passed (57 files parsed by the source checker).
- `node scripts/check-import-schema.mjs` — passed (6 import integrity checks).
- `node scripts/check-security.cjs` — passed (static checks).
- `node scripts/license-tool.cjs self-test` — passed.
- Full `npm run build` — not run because `node_modules` is not installed in this environment.
- Generated-PDF visual regression and Vercel/Neon end-to-end tests — not run.

This is a source candidate, not a claim of production certification.
