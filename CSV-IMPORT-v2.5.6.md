# SOLIVY Finance v2.5.7 — Universal CSV Import + Transaction Clear

## CSV Import
The CSV Import module now requires the user to select the transaction/master-data type before uploading.

Supported templates:
- Parties
- Third Parties
- Party Bank Accounts
- Company Bank / Cash Accounts
- Purchases / Samples
- Payments
- Money In / Receipts
- Interest Payments
- Funding / Loans
- Sales / Receivables
- Financing Receivables

The selected type displays all expected headers and marks required headers. A template can be downloaded directly from the UI. Preview validates headers and does not write to the database.

## Clear Transaction Data
Admin-only action available in Backup / Restore:

`Clear Transaction Data`

Confirmation phrase:

`CLEAR TRANSACTIONS LIVE`
or
`CLEAR TRANSACTIONS TEST`

This clears only financial transactions and preserves master data, including parties, third parties, bank accounts, company accounts, users and settings. The existing `Purge Database` remains the destructive operation.
