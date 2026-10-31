export const n=(v:any)=>Number(v||0);
export const money=(v:number)=>{
  let currency='INR';
  if(typeof window!=='undefined'){
    try{const saved=window.localStorage.getItem('solivy-currency');if(saved&&['INR','USD','EUR','AED'].includes(saved))currency=saved;}catch{}
  }
  const locale=currency==='INR'?'en-IN':'en-US';
  return new Intl.NumberFormat(locale,{style:'currency',currency,maximumFractionDigits:currency==='INR'?2:2,minimumFractionDigits:currency==='INR'?0:2,currencyDisplay:'symbol'}).format(Number.isFinite(Number(v))?Number(v):0);
};
export function purchaseCalc(x:any){const gross=Math.round(n(x.net_weight)*n(x.rate));const newQualityRate=n(x.quality_deduct_rate_per_kg);const usesNewQualityRule=newQualityRate>0;const quality=Math.round(usesNewQualityRule?n(x.rate)*newQualityRate:n(x.net_weight)/1000*n(x.quality_deduct_per_mt));const discountBase=Number(x.discount_after_quality??1)===1?Math.max(0,gross-quality):gross;const discount=Math.round(discountBase*n(x.discount_pct)/100);const moistureDeduction=usesNewQualityRule?0:n(x.moisture);const total=Math.round(n(x.freight)+n(x.unload_charge)+moistureDeduction+discount+n(x.driver_rokdi)+n(x.other_charges)+quality);return {gross_amount:gross,discount_amount:discount,quality_deduct_amount:quality,discount_base_amount:discountBase,total_deduction:total,net_payable:Math.round(gross-total)};}

/**
 * Which discount base a purchase was actually saved with (v2.8.0).
 *
 * `purchaseCalc` applies the percentage discount either to the gross amount or to gross minus the
 * quality deduction, controlled by company_settings.discount_after_quality. The setting is read at
 * save time, so a record saved under one setting and later opened under another was recomputed in
 * the form with today's rule while the register kept the stored total — the two disagreed by
 * quality × discount%. Historic documents are never recalculated, so the rule a record was saved
 * with is what must be used to display it:
 *
 *  1. `purchases.discount_after_quality` when the record carries it (written since v2.8.0);
 *  2. otherwise the rule whose calculation reproduces the stored net_payable exactly;
 *  3. otherwise the current company setting, and `reproduces` is false so the screen can flag the
 *     record instead of showing a figure that disagrees with the ledger.
 */
export function effectiveDiscountRule(row: any, companyDefault: number): { rule: number; reproduces: boolean; stored: number | null; calculated: number } {
  const stored = row?.net_payable === undefined || row?.net_payable === null ? null : Math.round(Number(row.net_payable));
  const explicit = row?.discount_after_quality;
  const candidates = explicit === 0 || explicit === 1 ? [Number(explicit)] : [1, 0];
  for (const rule of candidates) {
    const calculated = Math.round(purchaseCalc({ ...row, discount_after_quality: rule }).net_payable);
    if (stored === null || calculated === stored) return { rule, reproduces: stored !== null, stored, calculated };
  }
  const rule = Number(companyDefault) === 0 ? 0 : 1;
  return { rule, reproduces: false, stored, calculated: Math.round(purchaseCalc({ ...row, discount_after_quality: rule }).net_payable) };
}
