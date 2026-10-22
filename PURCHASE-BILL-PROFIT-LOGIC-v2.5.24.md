# Purchase & Rate Analysis — bill-level earnings

The Purchase & Rate Analysis table and its Excel export include bill-level financing earnings when a purchase has a linked financing receivable.

- **Receivable Profit** = `max(0, receivable_amount - cost_amount)`.
- **Receivable Profit % on Cost** = `Receivable Profit / cost_amount × 100`, when cost is greater than zero.
- **Profit Earned as of Today (receipt-based)** = `Receivable Profit × min(1, max(0, received_amount / receivable_amount))`.
- **Profit Earned % on Cost** = `Profit Earned as of Today / cost_amount × 100`, when cost is greater than zero.
- **Profit Yet to Realize** = `max(0, Receivable Profit - Profit Earned as of Today)`.

This uses the stored agreed receivable and cumulative receipts. The current schema does not retain receipt-by-receipt principal/profit allocation or a daily accrual schedule. Therefore “earned as of today” means receipt-proportional realization, **not time-accrued interest**. If a purchase has no linked financing receivable, the report displays zero rather than fabricating an earning. The trading margin on sales is shown separately and is not attributed to a purchase lot because the current schema does not link sales cost to purchase lots.

Percentages remain numeric cells in Excel and display with a `%` suffix in the on-screen table. Excel exports continue to include the full dataset, date sort oldest-to-newest, filters and auto-fit column widths.
