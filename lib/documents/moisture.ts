/**
 * How moisture is DISPLAYED (v2.7.3). One source of truth for every screen, document, PDF, preview
 * and export, so a percentage is never printed as a rupee amount.
 *
 * Moisture is entered on the purchase screen as a PERCENTAGE ("Moisture (%)"). What the stored
 * percentage does to the money depends on which quality rule the purchase was saved with, and this
 * module only reports the amount the existing calculation (lib/utils.ts purchaseCalc) already
 * deducted — it never recalculates, re-derives or changes a stored figure:
 *
 *  - When a percentage and quality deduction amount are both present, the quality amount is
 *    shown in the Moisture row, including legacy-rule records. The percentage is never INR.
 *  - Per-kg quality rule (quality_deduct_rate_per_kg > 0): purchaseCalc deducts nothing for
 *    moisture; the quality deduction is the moisture deduction, so that amount is shown.
 *  - Legacy per-MT rule: purchaseCalc deducts the stored `moisture` value itself, so that value is
 *    the deduction amount. When it is a plausible percentage (0 < v <= 100) it is also the figure
 *    the user typed into "Moisture (%)", so both are shown — the percentage as a percentage and the
 *    deduction as money. Above 100 it can only be a rupee amount (older records were entered that
 *    way), so no percentage is claimed rather than printing something like "(750%)".
 *  - `moisture_deduction_amount`, if a record carries one, always wins as the amount.
 *
 * Nothing is shown when no moisture was entered and no moisture amount exists.
 */
export type MoistureDisplay = {
  /** The percentage as entered (0 when none). */
  percent: number;
  /** The rupee deduction the existing calculation applied for moisture. */
  amount: number;
  /** "20%" or '' when no percentage was entered. */
  percentText: string;
  /**
   * Label for the monetary deduction row, carrying the percentage when there is one. Templates and
   * the payment advice print their own "Less :" prefix, so it is not repeated here.
   */
  label: string;
  /** True when moisture should appear at all. */
  show: boolean;
  /** True when the purchase used the per-kg quality rule. */
  perKgRule: boolean;
};

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** A moisture percentage cannot exceed 100; a larger stored value is a legacy rupee amount. */
export const PERCENT_MAX = 100;

export function moistureDisplay(row: any): MoistureDisplay {
  const stored = num(row?.moisture);
  const qualityAmount = num(row?.quality_deduct_amount);
  const storedPercent = stored > 0 && stored <= PERCENT_MAX;
  // If moisture is entered as a percentage and a quality deduction exists, show that
  // quality amount in the Moisture row (not the percentage as INR). This also covers
  // records created with the legacy per-MT setting.
  const perKgRule = num(row?.quality_deduct_rate_per_kg) > 0 || (storedPercent && qualityAmount > 0);
  const explicit = num(row?.moisture_deduction_amount);
  const amount = storedPercent && qualityAmount > 0 ? qualityAmount : (explicit > 0 ? explicit : (perKgRule ? qualityAmount : stored));
  const percent = perKgRule ? stored : (storedPercent ? stored : 0);
  const percentText = percent > 0 ? `${percent.toLocaleString('en-IN', { maximumFractionDigits: 2 })}%` : '';
  return {
    percent, amount, percentText, perKgRule,
    label: percent > 0 ? `Moisture Deduction (${percentText})` : 'Moisture Deduction',
    show: percent > 0 || amount !== 0,
  };
}

/** Short form for a column or field that shows the percentage only: "Moisture (20%)" or ''. */
export function moistureText(row: any): string {
  const m = moistureDisplay(row);
  return m.percent > 0 ? `Moisture (${m.percentText})` : '';
}
