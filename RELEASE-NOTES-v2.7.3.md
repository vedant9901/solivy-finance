# SOLIVY Finance v2.7.3 — moisture display fix

Build: `SOLIVY-Finance-v2.7.3-MOISTURE-DISPLAY-FIX`. Baseline: v2.7.2 (unchanged, tagged).
**Display only.** No financial logic, stored value, document total or database structure changed.

## The problem

`purchases.moisture` is entered as a percentage ("Moisture (%)" on the purchase screen), but what it
does to the money depends on the quality rule the purchase was saved with:

- rate-per-kg rule (`quality_deduct_rate_per_kg > 0`): the calculation deducts nothing for moisture;
  the quality deduction *is* the moisture deduction;
- legacy per-MT rule: the calculation deducts the stored value itself.

Several displays printed that raw column as a rupee figure, so 20% appeared as a ₹20 deduction.

## The fix

`lib/documents/moisture.ts` is now the single source of truth for presentation. It reports the
percentage and the deduction amount **the existing calculation already applied** — it never
recalculates, re-derives or alters a stored figure.

| Where | Now shows |
|---|---|
| Commercial bill, third-party bill, purchase/sample bill — all five templates, PDFs and live previews | `Less : Moisture Deduction (20%)` … `(-) 20` |
| Payment advice | `Less: Moisture Deduction (20%)` with the calculated amount |
| Purchase / Sample screen | a **Moisture** tile showing `20%` and a separate **Moisture Deduction** tile showing the amount |
| Document settings labels | "Less: Moisture Deduction", "Moisture Deduction" |
| Purchases export (XLSX) | `moisture_percent` plus a derived `moisture_deduction` column |

Rules applied consistently:

- the percentage is only ever shown as a percentage, never as money;
- the amount is only ever the deduction the stored calculation produced;
- **one** moisture row, so nothing is deducted twice (under the rate-per-kg rule the quality
  deduction is that row, exactly as before);
- a stored value above 100 cannot be a percentage — older records were entered as rupee amounts —
  so no percentage is claimed for it rather than printing "(750%)";
- nothing moisture-related appears when no moisture was entered.

## Tests

`npm test` 68/68 (including the new case: a legacy ₹750 record, a 2.5% per-kg record, a 20% record
printing `Moisture Deduction (20%)` with ₹20, a record with no moisture showing nothing on any
template, identical labels and totals across all five templates, payment advice, and stored rows
asserted byte-for-byte unchanged before and after). `npm run test:online` 31/31 (real PostgreSQL 16,
not Neon), `npm run test:ui` 4/4, 22 legacy scripts including the updated moisture source audit.
