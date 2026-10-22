# SOLIVY Finance Manager — multi-company production architecture

This build uses a central admin database and isolated company databases:

- `data/admin.db` — users, roles, company list and user-company assignments
- `data/live.db` — default AKSH company LIVE data (legacy data is preserved)
- `data/test.db` — default AKSH company TEST data
- `data/companies/<companyId>/live.db` — other company LIVE data
- `data/companies/<companyId>/test.db` — other company TEST data

## Admin flow

1. Sign in as ADMIN.
2. Create companies under Users / Administration.
3. Create users and assign LIVE/TEST access per company.
4. Users see only companies assigned to them.
5. Switch company from the top company selector. The signed session is changed server-side and APIs receive the company identity from the signed session, not from a trusted browser value.
6. Admin Backup / Restore contains an **All Companies Backup** download with the admin database and every company's LIVE and TEST databases.

## Dashboard due dates

Vendor payment due dates are calculated from `purchase_date + payment_due_days` when no explicit due date exists. Receivable due dates use `bill_date + due_days`. The dashboard shows:

- PAY TODAY
- PAY TOMORROW
- RECEIVE TODAY
- RECEIVE TOMORROW
- THIS WEEK (through Sunday)

Only open/unpaid amounts are shown.

## Online deployment

SQLite is safe for a single application instance on a persistent disk. Do not deploy the SQLite files to an ephemeral/serverless filesystem. For multiple horizontally scaled application instances, migrate the database layer to PostgreSQL.


## v2.2 Finance flows

### Money In
Use **Money In** for bank/cash receipts that are not a financing receivable: Capital / Initial Fund, Loan Received, Party Advance, Interest Received, Refund, and Other Receipt. Each posted receipt credits the selected company account and is reversible.

### Interest Paid
Use **Interest Paid** to record interest paid from a bank/cash account. Each posted interest payment debits the selected account and reduces realised finance profit. It can be reversed with an audit-preserving reversal entry.

### Purchase profit rule
For financing purchases, **Receivable = Net Payable + Discount + Other Charges**. Discount and Other Charges are treated as financing profit/commission. Interest Paid is deducted from realised finance profit.
