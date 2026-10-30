# SOLIVY Finance v2.6.24 — Purchase and Third-Party Bill Date Display Fix

- Always prints a visible `Date: DD-MMM-YYYY` in the invoice header for purchase and third-party bills.
- Uses the purchase date first, with created-at as a fallback only for legacy records whose purchase date is blank.
- Hardens date formatting for date-only ISO strings and timestamps.
- Keeps the existing combined Sample No. / Date metadata option.
- No purchase, payment, receivable, or ledger data is changed by this display-only patch.

Verification: source patch applied and ZIP integrity checked. Full production build and generated-PDF visual regression tests have not been run.
