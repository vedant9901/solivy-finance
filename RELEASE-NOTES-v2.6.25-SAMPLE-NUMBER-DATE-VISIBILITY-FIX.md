# SOLIVY Finance v2.6.25 — Sample Number & Date Visibility Fix

## Root cause
The invoice metadata grid placed two label/value pairs in one row, but its second pair used x-coordinates beyond the A4 page's right edge. This clipped the Sample No. / Date pair even when the setting was enabled.

## Change
- Render each metadata pair on its own row within the invoice metadata box.
- Preserve the existing Sample No., combined Sample No. / Date, invoice number and bill number settings.
- No accounting data or transaction records are modified.

## Verification
Source-level layout fix applied. Production build and rendered-PDF regression tests must still be run before LIVE deployment.
