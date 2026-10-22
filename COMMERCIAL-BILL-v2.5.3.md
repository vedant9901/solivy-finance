# SOLIVY Finance v2.5.3 — Commercial Bill Update

Built on v2.5.2. This update changes only the commercial purchase bill PDF.

## Bill layout
- Red section: Client Company
- Green section: To Party
- Company master details come from Administration → Companies.
- Party details come from the selected party and its primary bank account.
- Bill/sample, date, HSN, weights, rate, gross amount, deductions, other charges, net payable and notes are shown when populated.
- Empty fields are omitted; no `-`, `N/A`, or blank GST labels are inserted.
- GST tax details are shown only when the purchase has an actual GST type/rate/amount.
- GSTIN/PAN are shown only when those values are actually present in the relevant master record.
- Party bank details are shown only when at least one bank field exists.

## Important
This remains a commercial purchase document/voucher, not a GST tax invoice unless the underlying transaction is configured and legally appropriate.
