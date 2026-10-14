# SOLIVY Finance v2.5.23 — Professional Invoice Layout Candidate

Changes in this candidate:
- Purchase date is surfaced in the invoice metadata. With “Combine Sample No. & Date” disabled, Dated appears separately beside the invoice number in the metadata order; with it enabled, sample number and purchase date are combined without duplicating the date.
- Item table uses a consistent invoice-style full-height grid, with the total row near the lower edge and footer positioned relative to the bill content rather than fixed at the bottom of the page.
- Existing optional fields still omit empty values and deductions remain conditional on the saved document settings.

Validation limitation:
This is a source-level patch. A full dependency installation, `npm run build`, PDF generation/render comparison, SQLite regression tests and Vercel/Neon end-to-end tests were not run here. Treat as a candidate and test against a copy of the database before replacing production.
