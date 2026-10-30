# SOLIVY Finance v2.6.29 — Moisture Amount & Data API Repair

Based on v2.6.28 test source.

## Fixes
- Commercial bill: when moisture percentage and the per-kg quality rule are active, a stored `moisture_deduction_amount` of `0` no longer suppresses the quality deduction amount. The quality deduction is displayed once in the Moisture row, not duplicated in a separate Quality Deduct row, and is included once in the printed total.
- API: restored the missing `/api/data` route used by dashboard and party-alias screens. This addresses the reported 404 for `/api/data?mode=LIVE&company_id=4`.
- Retains v2.6.28 changes for required truck number on new Purchase/Sample entries, profile details/password change, reversed-entry action restrictions, and request deduplication.

## Validation status
- Source/static checks: to be run for this package.
- ZIP integrity: to be checked at packaging time.
- Full Next.js production build and authenticated LIVE/TEST integration checks require a network-enabled environment and valid local database/session; they must not be claimed unless they pass.
