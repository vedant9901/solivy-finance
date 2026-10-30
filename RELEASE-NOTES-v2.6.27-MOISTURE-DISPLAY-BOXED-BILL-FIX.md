# SOLIVY Finance v2.6.27 - Moisture Display and Boxed Bill Fix

- Fixed the third-party bill moisture row so `include_moisture` is honored when checked.
- Shows moisture percentage in the label (for example, `Less: Moisture (15%)`) and aligns the deduction amount at the right.
- Under the per-kg quality deduction rule, moisture remains informational unless a stored `moisture_deduction_amount` is available. This avoids inventing a monetary deduction or changing posted accounting totals.
- Adds subtle separators between deduction rows to match the boxed invoice reference.
- Settings remain separate for Commercial Bill and 3rd Party Bill; `include_moisture` and `show_deductions` must be enabled for the third-party deduction section.

Verification: source patch and ZIP integrity checked. Full production build and rendered-PDF regression tests not run.
