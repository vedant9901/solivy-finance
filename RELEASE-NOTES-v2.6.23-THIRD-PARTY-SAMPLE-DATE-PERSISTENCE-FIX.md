# SOLIVY Finance v2.6.23 — Third-Party Sample No. & Date Persistence Fix

- Third-party document settings default `Combine Sample No. & Date` to enabled when the setting is absent on older installations.
- Added compatibility aliases for older saved setting keys.
- UI default and API default are aligned.
- The PDF generator reads the third-party bill settings and prints the purchase sample number and purchase date together.
- No purchase, receivable, payment, or supplier invoice records are modified.

Verification performed: source-level assertions and ZIP integrity only. Production build and actual PDF rendering against the client's database still need to be tested.
