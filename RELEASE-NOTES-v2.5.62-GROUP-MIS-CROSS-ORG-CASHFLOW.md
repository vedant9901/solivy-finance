# SOLIVY Finance v2.5.62 — Group MIS and Cross-Organization Cashflow

## Included
- Fixed Bank Matching response typing by placing `difference` in the JSON response body; bank matching now reads and matches all account transactions, not only purchase payments.
- Reworked Group MIS with authorized multi-select organization filtering, business-at-a-glance KPIs, monthly cash movement, organization comparison, book profit, collected/earned profit, purchase cost, paid-to-vendors, financing receivables and top parties ranked by posted purchase value.
- Changed finance profit recognition to use receivable margin (`receivable_amount - cost_amount`) proportionally to the amount collected, less posted interest. Group MIS labels book profit separately from collected/earned profit and warns that funding capacity is not cash available.
- Added browser-local theme palettes (teal, blue, violet, emerald, amber, rose), with accent applied to primary controls and supported generated PDFs (payment advice and invoice heading).
- Added an organization selector to Money Out for `Other Money Out` and `Loan Principal Repayment`. When selected, the source account is debited and a matching Money In is created in the selected destination account, only for organizations the user can access in the same LIVE/TEST environment. Refunds are intentionally blocked from being routed across organizations.
- Stored destination company/receipt references on inter-company Money Out records and added compensating reversal logic for the matching destination receipt.
- Fixed middleware menu entitlement mapping for `/api/money-out`.
- Financing Receivables table already includes Party Name; the query joins the financing receivable party master.

## Verification performed
- TypeScript parser/source audit: passed for 75 source files.
- Security, sync, TEST-to-LIVE, user/org conflict, Money Out, multi-company sync, transfer and license self-test scripts passed.
- SQLite smoke checks passed for revised finance-profit and purchase-ranked party aggregation expressions.
- ZIP integrity and package-secret audit performed before delivery.

## Limitations / deployment gate
- A full Next.js production build and browser/database end-to-end test were **not completed** in this environment because dependency installation timed out. Do not treat this package as production-certified until `npm install` and `npm run build` pass on the target machine.
- English/Hindi/Gujarati selector is available globally and persists in browser local storage; existing navigation labels are translated, but not every form label, validation message, report column, or PDF text has been localized yet. Full application-wide translation remains incomplete.
- Theme colors affect the application accent and selected PDF elements; not every hard-coded illustration/chart/status color in every document has been converted to a theme token yet.
- Cross-organization Money Out posts a corresponding destination Money In after validation. Because organization databases may be separate, the implementation uses compensating reversal rather than a single distributed database transaction. Reconcile both organizations if a process is interrupted during posting/reversal.
- Funding Capacity is an indicative book-profit-based figure, not bank cash availability, a lending decision, or statutory financial advice. Consolidated values assume a common currency; no FX conversion is performed.
