# SOLIVY Finance v2.5.64 — Commercial Bills theme prop fix

## Fix
- Passed the persisted application `theme` state into `CommercialBills` from `app/page.tsx`.
- Added `theme: string` to the component prop type so the purchase and third-party bill URLs can include the selected PDF accent theme without referencing an undefined identifier.
- Incremented the package version to 2.5.64.

## Verification
- Source regression checks and TypeScript/TSX syntax parsing pass.
- The full Next.js production build could not be run in the packaging environment because npm dependency installation timed out. Do not treat this package as production-build-certified until `npm run build` completes successfully on a machine with dependencies installed.
