# ADR-001 — Derived double-entry journal (v2.7.0)

**Status:** Implemented (read-only). Classifications marked *review* need confirmation by the client's Chartered Accountant before statutory use.

## Context
v2.6.30 records business documents (purchases, payments, receivables, sales, money in/out, interest, transfers) and a bank/cash book (`account_transactions`), plus a vendor sub-ledger (`ledger`). It has no general ledger: the app itself labelled its registers "not a balanced double-entry journal or trial balance". Balance Sheet, Trial Balance and General Ledger therefore cannot be produced from existing tables directly.

## Decision
Build the double-entry journal **on read** (`lib/accounting/journal.ts`) from the existing source records. No stored financial data is modified, migrated or recalculated. Every voucher must balance; anything that cannot be classified deterministically is posted to **Suspense (1900)** and listed as an exception — never guessed.

Amounts are integer paise internally; every voucher is asserted balanced.

### Source → voucher mapping
| Source | Debit | Credit |
|---|---|---|
| Bank/cash opening balance | Bank/Cash (1100-n) | Opening Balance Equity (3900) |
| Party opening balance (PAYABLE / RECEIVABLE) | 3900 / Trade Payables (2100, party) | 2100 (party) / 3900 |
| Purchase (posted) | Purchases (5100) = net payable | Trade Payables (2100, party) |
| Financing receivable created with a purchase | Trade Receivables – Financing (1200, party) | Sales – Financing (4100) = receivable amount |
| Sales invoice | Trade Receivables – Invoices (1210, customer) | Sales – Invoices (4200) = receivable base; GST Output (2300) = CGST+SGST+IGST |
| Vendor payment | 2100 (party) = gross | Bank (net paid from the bank row) + TDS Payable (2200) |
| Financing receipt | Bank (net) + TDS Receivable (1300) | 1200 (party) = gross |
| Sales receipt | Bank | 1210 (customer) |
| Money in: CAPITAL / LOAN_RECEIVED / PARTY_ADVANCE / INTEREST_RECEIVED / REFUND / OTHER_RECEIPT / INTERCOMPANY_* | Bank | Capital 3100 / Loans 2400 / Party Advances 2500 / Interest Income 4300 / Refunds Received 4500 *(review)* / Other Receipts 4400 *(review)* / Inter-company 2600 |
| Money out: LOAN_REPAYMENT / REFUND / OTHER / to another organization | Loans 2400 / Party Advances 2500 *(review)* / Other Expenses 5400 *(review)* / Inter-company 1500 | Bank |
| Interest paid (manual or scheduled) | Interest Expense 5200 | Bank |
| Transfer between own accounts | Destination bank | Source bank |
| Withdrawal | Drawings / Withdrawals 3200 *(review)* | Bank |
| Admin balance repair (`ADMIN_REPAIR`) | Bank / Suspense | Suspense / Bank (always an exception) |
| Reversal rows | exact mirror of the original voucher on the reversal date | |

Reversed purchases and cancelled receivables produce the original voucher plus a reversal voucher on the reversal date when that date is recorded (vendor-ledger `REVERSAL` row); otherwise both are omitted (*void*) and listed as an exception.

### Not posted (documented gaps)
* **Purchase GST** (`purchases.gst_amount`) is stored separately from net payable and is not part of the payable; it is reported in GST Input / ITC, not posted to the GL. Confirm with the CA whether purchase invoices include GST payable to vendors.
* **Inventory** is not valued in the GL (purchases are expensed). Inventory Valuation is a separate report (lot quantity × lot purchase rate).
* **Loan principal** appears in the GL only if it was received through Money In (`LOAN_RECEIVED`). Loans created in Funding without a receipt are listed as an exception, not fabricated.

### Reconciliation (enforced by tests, reported by `/api/reports?id=reconciliation`)
* Bank GL per account = opening + Σ credits − Σ debits from the bank book (by construction).
* Trade Payables per party = opening ± posted purchases − posted payments (gross). The v2.6.30 "outstanding" uses *allocated* payments; the difference is shown as unallocated vendor advances.
* Financing receivables per bill = receivable − received; sales receivables = total − received.
* TDS receivable = Σ active TDS credit entries; TDS payable = Σ TDS on posted payments.
* Suspense must be zero; trial balance must balance.

## Consequences
* Balance Sheet, P&L, Trial Balance, GL, cash flow and aging are available without touching historical data, for both online and offline databases (same code).
* Classification is centralised in one table (`CHART` + mapping functions) so a CA-approved change is a one-line edit, covered by tests.
* Performance: the journal is rebuilt per report request (O(rows)). Acceptable for SME volumes measured (< 100 ms for thousands of documents); a materialised journal can be added later without changing report code.
