# SOLIVY Finance v2.5.26 — controlled feature candidate

Base: `SOLIVY-Finance-v2.5.25-REMEDIATION-FIX1`. Existing LIVE/TEST database model and finance workflows are retained.

## Changes in this candidate

- **Tally ledger mapping:** added a company/environment-specific mapping table and API for purchase, sales, CGST, SGST, IGST, TDS payable, interest expense, default bank and default cash ledger names. Tally Export UI now lets users edit and save the mapping. Export continues to support voucher XML and a review workbook for the currently supported transaction types.
- **Bank statement column mapping:** CSV/Excel headers can now be explicitly mapped to transaction date, narration, reference, debit, credit, single amount, debit/credit indicator and running balance. Preview is required before saving; this feature stages statement rows for reconciliation and does not auto-post payment or ledger entries. Source filename is retained in the import register. MT940 remains supported. PDF and PDF-converted statements remain unsupported.
- **User deactivation safety:** the API now refuses to demote or deactivate the last active administrator. `TESTER` is accepted as a role because the UI already exposes it. User records are deactivated, not deleted.
- **Organization deactivation safety:** the API prevents deactivating the last active organization, while allowing the primary organization to be deactivated if another active organization exists. Organization records are deactivated, not deleted.
- Existing menu and dashboard-card access assignment UI is retained; Tally export and bank-statement import remain separate feature IDs.
- Existing secondary backup module is retained: admin configures an absolute path and daily time; it records success/error and retries after the configured time when the app is running and an admin session is polling the status endpoint. It is not an independent Windows service and cannot run while SOLIVY is stopped.

## Important limitations

- The Tally export is not certified against every TallyPrime release or customer company configuration. Ledgers must exist in Tally; test XML on a backup company and validate vouchers with an accountant. Financing receivable receipt-by-receipt history is not fully exported.
- Bank-statement import currently stages rows for reconciliation; it does not automatically create accounting vouchers or match statement rows against book entries. Header mapping helps with non-standard CSV/Excel exports but does not guarantee every bank-specific format.
- Existing sessions may remain valid until token expiry after an administrator deactivates a user or organization; immediate server-side revocation is not yet implemented.
- Dashboard card access controls presentation; it is not a substitute for API-level authorization. Menu/API entitlement checks remain separate.
- No automatic deletion of user or organization master records is added.
