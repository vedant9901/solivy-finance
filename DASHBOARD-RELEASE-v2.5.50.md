# SOLIVY Finance v2.5.50 — Executive Dashboard

Built on the v2.5.49 package supplied as the latest baseline.

## Dashboard additions
- Financial-year turnover with current FY and previous FY totals.
- Year-on-year turnover percentage comparison.
- Month-by-month comparison for each matching financial-year month (April–March).
- Average billing value for posted sales invoices in the current financial year.
- Average sales margin based on posted invoice total value less recorded cost amount.
- Top five customer parties by posted sales invoice turnover in the current financial year.
- Bank/cash balance and active loan principal displayed separately to avoid double counting.
- Responsive layouts for mobile, tablet and desktop.

## Calculation notes
- Financial year is April 1 through March 31, using the device's current date.
- Turnover uses posted `sales.total_value` invoices and `invoice_date`.
- Average billing value is current-FY posted sales turnover divided by current-FY posted invoice count.
- Margin is (posted sales total value − recorded `cost_amount`) / posted sales total value. This is a sales margin, not the existing financing-receivable realized-profit calculation.
- Funding panel shows current bank/cash account balances and active loan principal separately. It does not add loan principal to bank balances, because that could double-count money already deposited. Undrawn facilities and principal repayments are not inferred by the current schema.
- Existing role/menu permissions still determine which data the API returns. Users need Receivables access to see sales invoice detail and Accounts/Funding access for those underlying datasets.

## Verification
Source-level static checks are run on the package before release. A full Next.js production build and live database/API integration tests require dependency installation and a configured SQLite/PostgreSQL test environment; do not treat the ZIP as production-certified unless those checks pass in the target environment.
