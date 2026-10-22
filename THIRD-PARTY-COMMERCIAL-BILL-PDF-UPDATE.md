# SOLIVY Finance v2.5.23 — Commercial / 3rd Party Bill PDF update

Changes in this candidate:
- PDF metadata pairs are created only when the corresponding field is enabled and a meaningful value exists.
- Sample No. & Date can be combined with the Document Settings `Combine Sample No. & Date` toggle; combined mode suppresses the duplicate standalone date row.
- Third-party invoice number comes from the purchase entry's `invoice_no`; it does not fall back to the internal sample number as the invoice number.
- Removed misleading placeholder `Other References: 3rd Party Bill` and removed the false mapping of invoice/sample number into Buyer's Order No. The current purchase schema has no separate fields for these values.
- Main goods table now builds columns from enabled settings and available values, avoiding empty HSN/weight/rate/amount columns. Net/gross weight visibility is honored.
- Company address and party contact visibility settings are honored.
- Deductions are shown only when enabled and non-zero. Printed total subtracts exactly the displayed/selected deductions without modifying the saved purchase or ledger.

Validation completed:
- Source parse audit: 57 files.
- Import integrity checks: 6.
- Static security checks: pass.
- License self-test: pass.
- Full `npm run build`, runtime PDF rendering, and Vercel/Neon integration were not run in this environment; this ZIP is a source candidate, not a claim of fully certified production readiness.
