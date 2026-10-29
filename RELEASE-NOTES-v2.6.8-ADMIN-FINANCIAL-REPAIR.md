# SOLIVY Finance v2.6.8 — Admin Financial Repair

## Added
- Administrator-only Financial Repair section under Administration.
- Diagnosis of account balances from opening balance plus signed account transactions.
- Listing of suspicious finance receipt reversal entries for review.
- Optional bank-balance correction against a bank-statement-verified target.
- Requires a reason and exact confirmation phrase for current LIVE/TEST mode.
- Creates a pre-change SQLite backup before posting the correction.
- Posts a compensating CREDIT/DEBIT entry instead of deleting source transactions.
- Writes an audit_logs record with account, before balance, target, adjustment, reason and backup name.

## Safety limitations
- The balance adjustment corrects the selected account's calculated balance; it does not automatically identify or remove duplicate original entries, alter financing receivable status, or fix receipt allocation history.
- Only use a target confirmed against the actual bank statement. The operator is responsible for selecting the correct company, mode and account.
- The API and UI require runtime integration testing against a copied database before production use.

## Validation
- `node scripts/check-source.cjs`: PASS (84 files parsed).
- ZIP integrity: checked after packaging.
- Full Next.js production build and database integration tests: NOT RUN (dependencies are not installed in this workspace).
