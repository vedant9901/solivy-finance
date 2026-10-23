# SOLIVY Finance v2.5.63 — Finance MIS and Build Fix

## Fixes
- Corrected the Bank Matching amount-difference response to keep custom fields in the JSON body and HTTP status in ResponseInit.
- Added an explicit TypeScript type for the source-company lookup in the inter-company Money Out route.
- Changed Group MIS vendor-paid totals to sum posted payment allocations against posted purchase bills, rather than all posted payments.
- Added purchase payable outstanding, financing receivable outstanding, gross book margin, interest paid, book profit after interest and earned finance profit as separate measures.
- Updated Group MIS wording to distinguish book-profit funding headroom from actual bank/cash availability.
- Fixed Group MIS organization selection refresh when switching environment.
- Added a mapped source-organization selector to Money In. Selecting a source organization creates the destination Money In plus a matching debit Money Out in the source organization, with linked IDs and reversal handling; non-admin users need Money Out permission for the source organization posting.
- Made the Money Out destination organization selector visible from the default Refund form; choosing a destination converts the form to Other Money Out, preventing a party refund from being confused with an inter-company transfer. Server-side authorization and transaction-type validation remain enforced.
- Fixed Money Out reversal requests to include the active company ID, preventing reversals from accidentally defaulting to company 1.
- Added shared Hindi/Gujarati translations for common form fields, table column headings, navigation, theme options and key Group MIS labels/summaries. Translation is improved but not yet complete for every hard-coded paragraph, validation message and PDF text.
- Theme choices remain persisted in browser local storage and the supported PDF generators use the selected theme accent.

## Accounting definitions
- Purchase Cost: posted purchase net payable.
- Paid against Purchases: posted payment allocations linked to posted purchase bills.
- Purchase Payable Outstanding: purchase cost less allocations, floored at zero.
- Gross Book Margin: recorded financing receivable amount less its recorded cost amount.
- Book Profit after Interest: gross book margin less posted interest paid.
- Earned Finance Profit: collected share of the recorded financing margin less posted interest paid.
- Funding Headroom: a book-profit-based indicator, not actual available cash or a statutory profit-and-loss statement.

## Verification status
Source regression checks, SQL checks and ZIP integrity checks are run for this release. A full Next.js production build and online PostgreSQL end-to-end test must still be run on a machine with dependencies installed and the target environment configured. Language support in this build is improved for navigation and Group MIS but is not yet a complete translation of every form, validation message and PDF text.

## Build validation performed in this environment
- TypeScript/TSX syntax transpile: 75 files, zero syntax errors.
- Duplicate object-key audit: zero duplicate keys.
- Regression suites: source, security, database bridge, import schema, transfers, sync, TEST-to-LIVE, user/org conflicts, Money Out, multi-company sync, Group MIS/Bank Matching and license self-test passed.
- SQLite schema/migration and Group MIS SQL smoke tests passed.
- `npm install --ignore-scripts --no-audit --no-fund` timed out in this environment; offline installation also could not proceed because the required npm package metadata is not cached. Therefore a full `next build` and full semantic type check were not possible here. Run them on the target Windows build machine before deploying.
