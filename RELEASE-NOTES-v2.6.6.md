# SOLIVY Finance v2.6.6 — Financing Receivables TDS Settlement

## Changes
- Financing Receivables now asks for **Net Bank Amount Received**.
- Gross settlement is calculated as net bank credit + TDS deducted. This gross settlement is what reduces the receivable and determines whether it is fully received.
- TDS is shown as a separate **TDS Tax Credit**, not treated as an expense or an unpaid receivable amount.
- Bank account transaction records only the actual net bank credit.
- Existing API callers using the older `amount` field retain the previous semantics; the updated UI sends `bank_amount` explicitly.

## Example
For a receivable of ₹425,240, bank credit ₹424,815 and TDS ₹425:
- Gross settlement: ₹425,240
- Bank credit: ₹424,815
- TDS tax credit: ₹425
- Outstanding: ₹0; status: RECEIVED

## Validation
- `node scripts/check-source.cjs`: PASS (84-file TypeScript parse audit and source/dependency/Tailwind audit).
- ZIP integrity checked after packaging.
- Full production build and live DB test were not run; validate in TEST mode before applying to LIVE.

## Existing records
The code does not silently rewrite existing bank transactions. For a receipt recorded under the old workflow, reconcile the amount against the actual bank statement before reversing and re-entering it under the new workflow.
