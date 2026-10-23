# SOLIVY Finance v2.5.64 — Group MIS Funding Capacity & Loan Transfer Fix

## What changed

- Group MIS now includes Total Funding Capacity (estimate), with per-organization values and a consolidated value.
- Funding capacity is calculated as active loan principal outstanding after posted principal repayments, plus cumulative posted financing book profit, less posted interest, floored at zero. This is an indicative management estimate and is explicitly distinguished from available bank/cash and a credit limit.
- The main finance dashboard now uses `outstanding_principal` instead of original `principal_amount` when calculating its book-based funding capacity estimate. This avoids counting repaid principal as still available.
- In Inter-Company Data Transfer, Funding / Loans records have status ACTIVE rather than POSTED. The screen now lets the user select one active loan and routes it to the dedicated `/api/funding/transfer` endpoint, preserving the linked transfer, history snapshot, audit trail, and reversal checks. Generic JSON data-package transfer is not used for loans.
- Added regression assertions for Group MIS funding metrics and loan transfer selection/routing.

## Why loan transfers previously appeared unavailable

The generic Inter-Company Data Transfer selector only allowed rows with `status === 'POSTED'`. Funding loan records use `status === 'ACTIVE'`, so every loan checkbox was disabled and no loan could be selected. The dedicated Funding transfer endpoint already existed, but the generic transfer screen was not calling it. v2.5.64 fixes this UI-to-API mismatch and limits the operation to one loan at a time.

## Accounting definition

`Funding Capacity (estimate) = max(0, active loan principal outstanding + cumulative posted financing book profit - posted interest)`.

This is a management estimate based on the app's current model, not a statement of cash on hand, statutory equity, lender commitment, or audited profit. Available Bank / Cash remains a separate metric. Consolidated values should only be compared/summed across organizations using the same currency; no FX conversion is performed.

## Verification status

Source regression checks and TypeScript/TSX transpilation checks are run for this package. A full Next.js production build and end-to-end tests against a live Neon database must still be run on the user's build environment before deploying to LIVE.
