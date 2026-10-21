# SOLIVY Finance v2.5.51 — Dashboard KPI data-source fix

## Fixes
- Trading turnover and average bill value now use posted purchase bills (`purchase_date`, `net_payable`) because this workspace's primary recorded trading workflow is purchases, not the separate sales-invoice module.
- Current FY vs previous FY and Apr–Mar monthly comparisons use purchase bills.
- Top parties are ranked by posted purchase value for the current FY.
- Supplier payments, money-in receipts, sales invoices, withdrawals, profit margin and bank/cash funding are displayed as separate metrics to avoid treating payments as turnover.
- Funding displays posted bank/cash balances and shows active loan principal separately to avoid double-counting.

## Verification
- Source audit and database-bridge audit passed.
- Transfer regression source checks passed (15/15).
- Full Next.js production build and live database integration were not run in this environment because dependencies are not installed; this candidate is not certified production-ready until those tests pass.
