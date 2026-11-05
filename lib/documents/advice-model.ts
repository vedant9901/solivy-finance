import { moistureDisplay } from './moisture';

/**
 * What a payment advice shows for each settled bill (v2.12.1).
 *
 * The advice used to build its own list of deduction rows, separately from the one the bills use
 * (`billDeductions` in bill-model.ts). The two drifted, and the advice's copy was wrong in a way
 * that mattered:
 *
 *  - its query never selected `quality_deduct_rate_per_kg`, so a purchase saved under the
 *    rate-per-kg quality rule looked to it like a legacy one. Under that rule `purchaseCalc`
 *    deducts **nothing** for moisture and the stored `moisture` value is the percentage the user
 *    typed — which the advice then printed as a rupee deduction. A purchase recording 11.50 %
 *    moisture printed "Less: Moisture Deduction (11.5%) ₹11.50", a deduction the accounting record
 *    does not contain, and the rows no longer added up to the stored net payable.
 *  - selecting that column alone would have been worse: under the rate-per-kg rule the quality
 *    deduction *is* the moisture deduction, so the same amount would have appeared twice, once as
 *    moisture and once as quality.
 *
 * So the rule lives in one place now and both documents use it. Nothing here recalculates a stored
 * figure: every amount comes from the purchase row, and `reconciles` reports whether the rows add
 * up to the stored `total_deduction` rather than adjusting anything to make them.
 *
 * **There is no moisture threshold in the calculation, and none is invented here.** `purchaseCalc`
 * applies no threshold and no per-excess-percentage rate: a quality deduction arises only from a
 * `quality_deduct_rate_per_kg` or a `quality_deduct_per_mt` entered on the purchase. A threshold
 * printed on a supplier's goods-receipt note is the supplier's stated condition, not a rule this
 * software applies, so nothing here derives a deduction from one.
 *
 * The advice's layout is unchanged: this only corrects which rows carry which money, exactly as
 * `billDeductions` already did for the commercial bill.
 */
export type AdviceDeduction = { label: string; amount: number; key: string };

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const on = (s: any, key: string, def = true) => (s?.[key] === undefined ? def : !!s[key]);

/**
 * The deduction rows the advice prints, by the same rule the commercial bill uses, in the order the
 * advice has always printed them: unload, freight, moisture, discount, rokdi, quality, other.
 *
 * The only change to what appears is the one the bill already made: under the rate-per-kg quality
 * rule the quality deduction IS the moisture deduction, so it appears **once**, carrying the
 * percentage in its label, instead of a percentage printed as rupees plus a separate quality row.
 * Under the per-MT rule the stored moisture amount is what was deducted and quality is listed
 * separately, exactly as before. With every row enabled the rows sum to the stored
 * `total_deduction`; `reconciles` reports that rather than adjusting anything to achieve it.
 */
export function adviceDeductions(row: any, s: any) {
  const m = moistureDisplay(row);
  const quality = num(row?.quality_deduct_amount);
  const rows: Array<[string, number, string, boolean]> = [
    ['Unload Charges', num(row?.unload_charge), 'show_unload', false],
    ['Freight', num(row?.freight), 'show_freight', false],
  ];
  if (m.perKgRule) {
    // One row, never both: the quality deduction and the moisture deduction are the same money.
    if (m.percent > 0) rows.push([m.label, m.amount, 'show_moisture', true]);
    rows.push(['Discount', num(row?.discount_amount), 'show_discount', false]);
    rows.push(['Driver Rokdi', num(row?.driver_rokdi), 'show_driver_rokdi', false]);
    if (m.percent <= 0) rows.push(['Quality Deduct', quality, 'show_quality_deduct', false]);
  } else {
    if (m.show) rows.push([m.label, m.amount, 'show_moisture', false]);
    rows.push(['Discount', num(row?.discount_amount), 'show_discount', false]);
    rows.push(['Driver Rokdi', num(row?.driver_rokdi), 'show_driver_rokdi', false]);
    rows.push(['Quality Deduct', quality, 'show_quality_deduct', false]);
  }
  rows.push(['Other Charges', num(row?.other_charges), 'show_other_charges', false]);

  const deductions: AdviceDeduction[] = rows
    .filter(([, v, k, force]) => on(s, k) && (force || v !== 0))
    .map(([label, amount, key]) => ({ label, amount, key }));

  const shownTotal = Math.round(deductions.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  const storedTotal = num(row?.total_deduction);
  // With every row enabled the two must agree, within the rupee rounding `purchaseCalc` applies to
  // the stored total. A row the user switched off will not agree, and that is their choice.
  const allEnabled = rows.every(([, , k]) => on(s, k));
  return {
    deductions, shownTotal, storedTotal,
    reconciles: !allEnabled || Math.abs(shownTotal - storedTotal) < 0.51,
    hiddenRows: !allEnabled,
  };
}
