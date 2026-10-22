# SOLIVY Finance v2.5.23 — Payment Advice Design Update

## Changes
- Redesigned payment advice header with a clear document title, payment number, and compact issuer details.
- Added compact, side-by-side payment details and supplier/beneficiary bank sections.
- Redesigned bill-wise settlement entries as compact bordered cards with clear invoice/sample identifiers and aligned amounts.
- Preserved the existing `payment_advice_settings` switches for party details, bank details, allocations, individual deductions, summary lines, amount-in-words, payment date, UTR, and notes.
- Omitted empty supplier/bank fields and zero-value deduction rows.
- Changed the footer to follow the generated content instead of pinning it to a fixed bottom coordinate, reducing avoidable blank space.
- Added page continuation headings and dynamic page-break checks for longer advice documents.

## Checks run
- `node scripts/check-source.cjs` — PASS (57 files parsed)
- `node scripts/check-import-schema.mjs` — PASS (6 checks)
- `node scripts/check-security.cjs` — PASS (static checks)
- `node scripts/license-tool.cjs self-test` — PASS

## Not run / limitations
- `npm install` and `npm run build` were not run in this environment.
- PDF was not generated from a live SQLite database, and visual/browser/Vercel/Neon end-to-end tests were not run.
- These static checks are not a production certification. Test the payment advice against a copy of the database before deploying.
