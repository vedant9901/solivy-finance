# SOLIVY Finance v2.12.2 — payment advice moisture (layout unchanged), and bags on the bills

Baseline: v2.12.1. No schema change, no new API route, no new network call, no sync change, no change
to `purchaseCalc`.

Two changes:

1. the payment advice gets **only** the treatment the commercial bill already had — v2.12.1 had
   added information rows and notes to the advice, and those are removed;
2. **Bags** becomes a column option on the commercial and third-party bills, in Document Settings.

## 1. The payment advice: the commercial bill's treatment, and nothing more

v2.12.1 fixed a real defect (below) but also added two information rows and a note paragraph to the
advice, changing its layout. Those are gone. What remains is exactly what `billDeductions` already
did for the commercial bill: **the moisture percentage rides in the existing deduction row's
label**, and the money sits in the amount column.

The advice now prints, in the rows and order it always printed:

```
Rate / Kg | INR 20.00
Less: Moisture Deduction (11.5%) | (-) INR 12
Net Payable | INR 4,25,228
```

No new rows, no notes, no new settings. `docs/verification/payment-advice-moisture-v2.12.2.pdf` is
the rendered advice; it is 16,879 bytes against v2.12.1's 17,620, the difference being the rows
removed.

### The defect that is still fixed

The advice built **its own** deduction list, separate from the bills', and its query never selected
`quality_deduct_rate_per_kg`. A purchase saved under the rate-per-kg quality rule therefore looked
legacy to it, and the recorded moisture **percentage** was printed as a rupee deduction. Measured on
1,000 kg at ₹20 with 11.50 % moisture and a ₹0.50/kg quality rate:

```
purchaseCalc:  quality 10   total_deduction 10   net_payable 19990
advice (old):  Moisture Deduction (11.5%) 11.50  +  Quality Deduct 10  =  21.50
               → 21.50 against a stored total of 10: the document did not reconcile
               → selecting that column alone would have printed the same ₹10 twice
```

`lib/documents/advice-model.ts` holds that rule once now, and the advice uses it: under the
rate-per-kg rule the quality deduction **is** the moisture deduction and appears once with the
percentage in its label; under the per-MT rule the stored moisture amount is the deduction and
quality is listed separately. The row order the advice has always used is preserved — unload,
freight, moisture, discount, rokdi, quality, other — and a test asserts the advice and the bills
produce the same rows from the same purchase.

### Still true, and still needing your decision

`purchaseCalc` contains **no moisture threshold and no per-excess-percentage rate**. A quality
deduction comes only from `quality_deduct_rate_per_kg` (rate × rate) or `quality_deduct_per_mt`
(net_weight/1000 × rate). Nothing above 14 % was invented, and a source check fails the build if a
threshold ever starts multiplying anything in this path.

And with no quality rate stored, the legacy branch deducts the `moisture` field **itself** — so
11.50 is both the reading and ₹11.50 off the bill. Changing that would alter historic posted
amounts, so it is untouched. The three options are unchanged from the previous note: stop moisture
deducting by itself for new purchases (dated, with reversals for any to correct); give me the
above-14 % rate and basis to add as a company setting; or leave it as it is.

## 2. Bags on the commercial and third-party bills

A **Bags** column, listed in Document Settings for both bills as *Bags / Packages column*:

- **off by default**, so every existing bill prints exactly as it does today;
- turn it on and switch *Quantity* off to show packages instead of weight;
- both can be shown together, and then Bags prints before Quantity and after HSN, as an Indian
  invoice lists them;
- it prints the `bags_qty` recorded on the purchase (`375 Bags`), and nothing at all when no bags
  were entered — a figure that was never recorded is not printed as zero;
- it changes no money: the gross, the deductions, the total and the net payable are untouched, which
  the tests assert.

It is added in `lib/documents/bill-model.ts`, which all five bill templates share, so the column
appears identically whichever template is selected. The **purchase bill** (`/api/purchase-bill`) has
its own column list and was **not** changed — say the word if you want it there too.

## 3. Verification

Evidence: `docs/verification/test-run-2026-11-05-v2.12.2.txt`, rendered advice
`docs/verification/payment-advice-moisture-v2.12.2.pdf`.

| | Result |
|---|---|
| Typecheck | **PASS** — 0 errors |
| Offline suite (SQLite, both GRN samples) | **PASS** — 193/193 |
| Online suite (real PostgreSQL 16.15) | **PASS** — 57/57, including the advice through the bridge |
| Browser suite (Chromium) | **PASS** — 22/22 |
| Source invariants | **PASS** — 25/25 scripts, `check-payment-advice.cjs` 13 invariants |
| The advice's layout is unchanged | **PASS** — asserted in the source check and shown in the rendered PDF |
| The per-kg rule: one deduction row, reconciling with the record | **PASS** — offline and through the real endpoint |
| The advice and the bills produce identical rows | **PASS** |
| Received / dispatched / deducted weights and other deductions distinct | **PASS** |
| No accounting record written by opening or printing the advice | **PASS** |
| Bags: off by default on both bills | **PASS** |
| Bags instead of quantity, and both together in invoice order | **PASS** — both bills |
| Bags changes no money | **PASS** |
| Bags saves and reloads in Document Settings | **PASS** — real round-trip through the API |
| `next build`, `next lint` | **NOT VERIFIED** — the npm registry is unreachable here, so Next.js 15.5.27 is not installed |
| Neon | **NOT VERIFIED** — the online suite runs on a local PostgreSQL 16 |
| Windows | **NOT VERIFIED** — no Windows machine |
| Bags on the purchase bill | **NOT DONE** — deliberately; it was not asked for and has its own column list |

## 4. Changed files

- `app/api/payment-advice/route.ts` — the added information rows, the notes and the threshold lookup
  removed; the shared deduction model retained, with the quality-rule columns it needs.
- `lib/documents/advice-model.ts` — reduced to `adviceDeductions`, preserving the advice's row order.
- `lib/documents/bill-model.ts` — the Bags column, off by default.
- `app/api/document-settings/route.ts`, `app/page.tsx` — `show_bags` for both bills and its label;
  v2.12.1's two advice settings removed, since the rows they controlled are gone.
- `tests/integration/payment-advice-moisture.test.ts` — trimmed to the deduction behaviour.
- `tests/integration/bill-bags-column.test.ts` — **new**, 8 tests.
- `tests/online/bridge.test.ts` — the online advice test trimmed to match.
- `scripts/check-payment-advice.cjs` — invariants updated: the layout must stay unchanged and no new
  advice setting may appear.
- `CHANGELOG.md`, `WORKLOG.md`, `ARCHITECTURE.md`, `RELEASE-STATUS.md`, this file (which replaces
  `PAYMENT-ADVICE-MOISTURE-v2.12.1.md`).
