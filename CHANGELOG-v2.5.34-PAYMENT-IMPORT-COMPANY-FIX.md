# SOLIVY Finance v2.5.34 — Payment Import Company Fix

## Fix
- CSV preview and import now explicitly send the selected company ID and authenticated environment in request headers and form data.
- This prevents import-finance from silently defaulting to organization ID 1 when the user is working in another organization.
- Company account matching now trims whitespace and ignores case while preserving the active-account requirement.
- A failed account lookup reports the selected organization, environment, and available active account names to aid diagnosis without creating duplicate accounts.

## Important
- This is a source-level fix. Validate the payment CSV in TEST mode first, in both local SQLite and hosted PostgreSQL/Neon before production use.
- The importer continues to post payment, account transaction, and party ledger entries together using the existing transaction logic.
