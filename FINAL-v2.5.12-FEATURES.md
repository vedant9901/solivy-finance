# SOLIVY Finance v2.5.12

## Payment allocation and advice
- Payment creation can select one or more outstanding purchase bills.
- Partial bill allocations are supported.
- Existing posted payments can be edited to add/change bill allocations.
- Existing accounting date is loaded from the saved payment record.
- Payment Advice prints purchase details and bill-wise deductions line-by-line.
- Payment Advice fields are controlled by Document Settings.

## Commercial / 3rd Party Bills
- Separate Commercial Bill and 3rd Party Bill document settings.
- Separate deduction inclusion flags for each document.
- Third Party Bill uses the selected active third party as Buyer.
- Printed total is calculated from the selected deduction settings.

## Dashboard
- Added overdue financing receivables with sample number, bill number, due date, days overdue and outstanding amount.

## Reliability / build fixes
- Removed the Node `crypto` dependency from middleware so the Edge runtime does not import `lib/session.ts`.
- Removed non-handler `defaults` export from the document-settings route, fixing Next.js route type validation.
- Kept sortable responsive shared Table component; desktop headers sort and mobile cards provide a sort selector.
- Historical `setSort` duplicate declaration is not present.
- Historical `security.admin is not a function` import pattern is not present.
- Historical `p.payment_date` references were audited; remaining references are against the `payments` table alias and are valid.
- Source parse audit: 48 TS/TSX files, 0 syntax errors.
- Existing `check:source` and `check:security` scripts pass.

## Important verification note
A complete dependency-backed `next build` could not be executed in the build environment because `npm install --prefer-offline` timed out. No claim of a completed production build is made on that basis.
