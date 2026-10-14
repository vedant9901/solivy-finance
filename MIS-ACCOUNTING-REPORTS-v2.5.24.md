# SOLIVY Finance v2.5.24 — High-level MIS, Accounting & Filing Reports

## Report modules
Each module is opened from the Reports screen. The active module has its own explanation, filters, table, and Excel export.

1. **Executive MIS** — period-filtered purchase value, taxable sales, net quantities, weighted average buying rate, recorded trading margin, financing income, interest expense and estimated profit. The workbook export is available alongside the monthly trend export.
2. **Profit & Loss** — month-wise taxable sales (excluding GST), recorded sales cost, trading gross profit, realised financing margin, posted interest and estimated net profit.
3. **Purchase & Rate Analysis** — supplier, purchase/sample/invoice references, bags/quantity, gross/net weight, entered rate, gross amount, deductions/charges, net payable, payments and outstanding.
4. **Sales & Receivables** — invoice tax split, cost amount, gross margin excluding GST, receipts and outstanding customer balances.
5. **Payment & Payables** — posted vendor payments, general money-in receipts, and individual financing receipt bank/cash credits. Financing receipt bank credits come from individual account transactions; they are not confused with the receivable's full bill value.
6. **Accounting Registers** — party ledger, money-in and interest registers for source-wise review. This is not represented as a balanced double-entry journal or trial balance.
7. **Cash & Bank Book** — posted bank/cash account movements with date, account, direction, reference, signed amount and narration.
8. **Outstanding Ageing** — vendor payables and financing receivables grouped by due date and days past due. Date filters apply to the due date in this module.
9. **GST Output Filing** — outward invoice working register with GSTIN, HSN/SAC, taxable value, GST split and invoice total.
10. **GST Input / ITC** — purchase-side input GST working report from recorded purchase tax fields.
11. **TDS & Tax Working** — TDS recorded on vendor payments and financing receivables, including recorded base, rate, section and net amount where available.

## Excel export behaviour
- MIS downloads sort by the report's date column (or month for monthly reports), using the chosen oldest-first/newest-first setting.
- Legacy purchase, payment, ledger and GST downloads sort newest-first by their transaction date.
- Column widths are calculated from headers and every exported row, with a width cap to keep very long notes from making the workbook unusable.
- Date columns with ISO dates are exported as actual Excel date cells and formatted `dd-mmm-yyyy`.
- Numeric values remain numeric cells; references, invoice numbers, GSTINs and other identifiers remain text.
- Autofilter headers are included. The on-screen table shows up to 500 rows for responsiveness; the Excel export includes the complete rows returned for the selected company/environment.

## Calculation and reconciliation safeguards
- Weighted average buying rate is `SUM(entered rate × net weight) / SUM(net weight)`. The stored weight unit is not inferred; confirm whether entries use kg, quintal or MT before comparing rates.
- Effective purchase cost per weight unit is `SUM(net payable) / SUM(net weight)` and can differ from the entered buying rate because of deductions and charges.
- P&L is a management estimate, not statutory accounts. It includes recorded taxable sales, recorded sales cost, realised financing margin and posted interest only. It does not infer unrecorded expenses, inventory valuation, accruals, depreciation, provisions or tax.
- Sales are grouped by invoice date. Financing margin is allocated using the receivable record and its latest stored receipt date. Because the current data model aggregates partial receipts on the receivable row, period-wise financing margin cannot be allocated exactly for each partial receipt without a schema change. Individual bank credits are still date-accurate in Cash & Bank Book and Payment & Payables.
- Receivable TDS fields are cumulative on the receivable record rather than a separate receipt-wise TDS ledger. Reconcile against the actual TDS certificate/Form 26AS before filing.
- GST and TDS reports are filing workpapers, not submitted returns or tax advice. Reconcile with books, portal data and a CA before filing.
- Reports do not create, alter or post financial transactions. LIVE/TEST and company context remain the application's active context.

## Validation performed
- `npm run check:source`: PASS — TypeScript parse audit checked 57 files; source/dependency/Tailwind audit passed.
- `npm run check:import`: PASS — all 6 import schema/integrity checks passed.
- `npm run check:security`: PASS — security/responsive audit passed.
- `npm run check:license`: PASS — Ed25519 sign/verify self-tests passed.
- Full `npx tsc --noEmit` and `npm run build`: **not verified in this workspace** because dependency installation timed out. Run them after `npm install` on the Windows machine before replacing the current project.
