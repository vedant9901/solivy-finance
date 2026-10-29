# SOLIVY Finance v2.6.9 — Financial Repair + TDS Credit Tracking

Baseline: `SOLIVY-Finance-v2.6.8-ADMIN-FINANCIAL-REPAIR.zip`.

## Changes
- Retains Admin → Financial Repair diagnostics and the verified closing-balance correction workflow. Corrections post a compensating account transaction after a pre-change database backup, require a reason and environment-specific confirmation, and create an audit log. Original transactions are not silently deleted.
- Adds a company/environment database table `tds_credit_entries` to track TDS deducted from financing receivable settlements with date, amount, section, certificate reference, source bank-credit transaction, status and narration.
- Reports active and reversed TDS credits in repair diagnostics. Reversing a finance receipt marks related TDS credits as reversed without deleting the audit history.
- TDS deducted from a receivable is treated as a **TDS receivable / advance-tax asset**, not as an operating expense. The bank/cash account records only the net amount received; the gross receivable is settled by net bank receipt plus TDS credit. Have the CA confirm the ledger mapping and claim certificate/26AS credit before filing.
- Uses paise precision for the receivable settlement amounts touched by this flow.

## Verification notes
- Source/static checks must pass before release. A full Next.js production build and live financial regression tests require installed dependencies and must be run in the release environment.
- Test on a copied TEST database first: partial TDS receipt, full TDS settlement, reversal, repeated reversal rejection, bank balance before/after, and TDS active/reversed totals. Do not test repairs directly against LIVE data.
