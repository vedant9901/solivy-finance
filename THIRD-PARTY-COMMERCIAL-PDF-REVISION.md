# SOLIVY Finance v2.5.23 — Commercial / 3rd Party Bill PDF Revision

## Changes
- Returned to the compact bill-table layout from the earlier commercial bill candidate instead of the later fixed-height table layout.
- Invoice No. prints the actual `Invoice No` saved on the selected Purchase Entry. The sample number is not silently substituted for a missing invoice number.
- Sample number and purchase date can be combined using Document Settings → 3rd Party Bill → Combine Sample No. & Date. When enabled, the metadata label is `Sample No. / Date`; when disabled, sample and date are separate rows.
- Removed the fabricated `Reference No. & Date` display because Purchase Entry has no independent reference-number field.
- Removed the duplicate `Kg` printed below a quantity that already includes `Kg`.
- Amounts use Indian digit grouping and two decimal places (for example `8,50,800.00`). Avoids the unsupported rupee glyph that rendered as a stray superscript in jsPDF's built-in Helvetica font.
- Deduction amounts use readable Indian grouping without a currency glyph.

## Checks completed
- `node scripts/check-source.cjs` — PASS (57 files)
- `node scripts/check-import-schema.mjs` — PASS (6 checks)
- `node scripts/check-security.cjs` — PASS (static checks)
- `node scripts/license-tool.cjs self-test` — PASS
- Full `npm run build` — NOT RUN: `node_modules` is not present in this environment, and dependency installation was not completed.
- Generated PDF rendering / browser / Vercel / Neon end-to-end tests — NOT RUN.

This is a source revision candidate, not a claim of a fully production-certified build. Test PDF output with a copy of your data before replacing your working installation.
