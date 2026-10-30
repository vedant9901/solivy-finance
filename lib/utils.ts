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
