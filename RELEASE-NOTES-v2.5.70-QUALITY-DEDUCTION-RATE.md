# SOLIVY Finance v2.5.70 — Quality Deduction Rate

Based on `SOLIVY-Finance-v2.5.69-SYNC-COMPANY-SETTINGS-FIX1`.

## Purchase calculation change
- Renamed the form label to `Moisture (%)`; with the new quality-rate rule it is informational and is not added to money deductions.
- Added `Quality Deduction Rate (₹ / kg)` as a separate input.
- New rule: `Quality Deduction Amount = Rate / kg × Quality Deduction Rate (₹ / kg)`.
- Example: Rate ₹27 and quality deduction rate ₹310 gives a quality deduction of ₹8,370.
- The quality deduction is included in Total Deduction and reduces Net Payable.
- Added a separate persisted database column, `quality_deduct_rate_per_kg`, so existing `quality_deduct_per_mt` records retain their legacy calculation behavior.
- Updated purchase creation/editing, purchase CSV template/import, and commercial bill deduction display.

## Verification performed
- Source/transpile audit passed (78 files).
- Import schema checks passed.
- Database bridge source audit passed (56 API route files).
- Company-settings sync regression checks passed.
- Release-safety source check passed.
- Calculation sanity check: ₹27 × ₹310 = ₹8,370.

## Verification limitation
A full Next.js production build and live online/offline accounting regression tests were not run in this environment. Test against a backup/staging database before production deployment.
