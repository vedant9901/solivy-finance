# SOLIVY Finance v2.6.22 — Third-Party Combined Sample No. & Date Fix

- Fixed the third-party bill PDF metadata logic so `Combine Sample No. & Date` controls the combined output directly.
- The combined option now includes the sample number even if the separate `Sample No.` display checkbox is disabled.
- Added explicit default values for the combined setting in commercial and third-party document settings.
- When combined mode is enabled, the purchase date is printed in the combined `Sample No. / Date` field and is not duplicated as a separate `Dated` field.
- No purchase, payment, receivable, or party data is modified by this change.

Verification: source-level patch only. Full production build and PDF rendering/database regression tests have not been run.
