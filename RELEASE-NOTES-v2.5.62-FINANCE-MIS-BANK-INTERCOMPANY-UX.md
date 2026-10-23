# SOLIVY Finance v2.5.62 — Finance MIS, Bank Matching & Multi-Company UX

## Changes
- Reworked Group MIS into a management finance overview with multi-organization selection and organization comparison.
- Group MIS reports purchase cost, allocated vendor payments, vendor outstanding, financing receivables, collections, book profit, finance profit after interest, available cash and cashflow.
- Top parties are ranked by posted purchase value, with paid and outstanding amounts; Money In/Out ledger movement is not used as the ranking basis.
- Group MIS derives the environment from the authenticated session and validates selected organizations against user-company mapping.
- Bank Matching now works from account transactions across recorded transaction types, with party/counterparty, narration, account, recorded amount and reconciliation state.
- Bank amount-difference details are returned in JSON response data, not in `ResponseInit`.
- Money Out supports an optional mapped destination organization/account for Other Money Out and Loan Principal Repayment, creating a matching Money In receipt in the destination. Refunds remain party refunds and cannot be routed as generic inter-company transfers.
- Inter-company source narration includes the destination organization; destination receipts identify the source organization. Reversal also reverses the paired destination receipt, subject to access mapping.
- Hindi, Gujarati and English selector remains browser-persisted. Added a browser-persisted accent palette with teal, blue, violet, emerald, amber and rose options; common app accent components and payment-advice PDF accent follow the selected palette.
- Financing Receivables table includes the party name. Mapped organization parties continue to be mirrored as read-only party masters without copying ledger balances.

## Accounting interpretation
- Book profit is the sum of recorded financing discount and other-charge margin on posted financing receivables.
- Finance profit after interest is book profit less posted interest. It is a management indicator, not statutory P&L.
- Funding available is presented as an indicative measure based on active loan principal plus cumulative book profit less interest; it is not the same as cash available. Bank/cash balance remains separately shown.
- Inter-company Money Out/receipt pairing is supported for Other Money Out and Loan Principal Repayment. The target receipt uses the destination's selected active bank/cash account. LIVE and TEST remain isolated.

## Verification limits
- Source parse/security/source-regression checks are run in this environment.
- Dependency installation timed out; the Next.js production build and full TypeScript semantic check could not be completed here. Run `npm install` and `npm run build` on the release machine before production rollout.
- Cross-company accounting requires an end-to-end test in TEST with two mapped organizations, a destination account, a posted outflow, matching receipt, and reversal before LIVE rollout.
- The current localization covers navigation plus the new MIS/Bank Matching experience; not every legacy form label or every PDF text string is translated yet. Theme accent is app-wide for common accents and payment-advice PDF, but legacy hard-coded status/brand colors and monochrome commercial bill PDF may remain unchanged.
