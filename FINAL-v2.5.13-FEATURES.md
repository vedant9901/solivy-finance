# SOLIVY Finance v2.5.13 — Payment Advice Presentation

## Changes
- Payment Advice now shows Bags / Packages from the linked purchase bill.
- Payment Advice shows Net Weight, Gross Weight and Rate / Kg from the purchase.
- Discount is shown line-by-line as `Less: Discount (X.XX%)` when a discount exists.
- Discount percentage is read from the purchase `discount_pct`; if unavailable, it is derived from discount amount / gross amount.
- Document Settings adds checkboxes for Bags / Packages, Gross Weight and Show Discount %.
- Payment Advice uses a cleaner professional card/section layout with bill-wise reconciliation.
- Existing payment allocation/accounting logic is preserved.
- Existing security middleware/session architecture is preserved.
