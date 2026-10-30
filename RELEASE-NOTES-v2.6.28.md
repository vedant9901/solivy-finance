# SOLIVY Finance v2.6.28 — Truck Number, Moisture, Profile & Reversal Fixes

Based on `SOLIVY-Finance-v2.6.27-MOISTURE-DISPLAY-BOXED-BILL-FIX`.

## Changes
- Commercial bill: when the per-kg quality rule is active and moisture is entered, the moisture deduction row displays the existing quality deduction amount. The separate Quality Deduct row is suppressed in that specific case to avoid counting the same deduction twice on the printed total. Accounting calculations remain unchanged.
- Purchase / Sample: added Truck Number. New purchase creation and purchase CSV imports require it. Existing historical rows may remain blank, and editing a legacy row does not force a truck number.
- User Profile: shows user ID, username, name, role, active organization, environment and authorized menu modules. Adds authenticated current-password verification and password change (minimum 12 characters).
- Reversed purchases: Edit and PDF actions are hidden in the register; the purchase update API and bill PDF endpoint also reject reversed entries.
- Performance: identical concurrent GET requests through the main API helper are deduplicated while in flight. No persistent response cache was introduced, so writes and subsequent reads are not served stale data by this optimization.
- Online/offline database compatibility: added a safe `truck_number` column migration with an empty default for existing SQLite databases.

## Verification
- `scripts/check-source.cjs`: PASS
- `scripts/check-security.cjs`: PASS
- `scripts/check-database-bridge.mjs`: PASS
- `scripts/check-sync.mjs`: PASS
- `scripts/check-import-schema.mjs`: PASS
- `scripts/check-release-safety.cjs`: PASS
- `scripts/check-online-login-org.cjs`: PASS
- `scripts/check-sync-company-settings.cjs`: PASS
- ZIP integrity: to be checked at packaging time.
- Full `next build`: NOT VERIFIED. `npm install --ignore-scripts --no-audit --no-fund` timed out and offline installation failed because required packages were not cached. Do not deploy as a production-approved build until dependencies can be installed and `npm run build` passes.
