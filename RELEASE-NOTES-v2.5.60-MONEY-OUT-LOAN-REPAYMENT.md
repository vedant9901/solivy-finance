# SOLIVY Finance v2.5.60 — Money Out, Refunds and Loan Principal Repayment

## Added
- New Money Out module with Refund, Loan Principal Repayment and Other Money Out purposes.
- Refund party dropdown shows total posted Money In, previously refunded and outstanding.
- Refund amounts are checked server-side against the party-level outstanding balance.
- Loan repayment dropdown shows outstanding principal (original principal less posted principal repayments).
- Full repayment option fills remaining principal; server-side validation prevents overpayment.
- All outflows post a DEBIT to the selected bank/cash account. Refunds also create a party-ledger credit. Loan interest remains separate in Interest Paid.
- Reversals mark Money Out reversed and post an account credit; refund/loan balances recalculate from posted records.
- Added sync, purge, TEST-to-LIVE, menu and API entitlement wiring for the new table/module.

## Verification
Run `npm run check:money-out`, `npm run check:source`, `npm run check:security`, `npm run check:sync`, `npm run check:test-to-live`, and `npm run build` before client release. Full production build and database integration tests have not been run as part of this patch.
