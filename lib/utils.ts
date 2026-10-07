export const n=(v:any)=>{const x=Number(v);return Number.isFinite(x)?x:0};
export const money=(v:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0,minimumFractionDigits:0}).format(Math.round(Number.isFinite(Number(v))?Number(v):0));
export function purchaseCalc(x:any){
 const net=Math.max(0,n(x.net_weight));
 const rate=Math.max(0,n(x.rate));
 const gross=Math.round(net*rate);
 const discountPct=Math.min(100,Math.max(0,n(x.discount_pct)));
 const discount=Math.round(gross*discountPct/100);
 const qualityRate=Math.max(0,n(x.quality_deduct_per_mt));
 const quality=Math.round(net/1000*qualityRate);
 const freight=Math.max(0,n(x.freight));
 const unload=Math.max(0,n(x.unload_charge));
 const moisture=Math.max(0,n(x.moisture));
 const driver=Math.max(0,n(x.driver_rokdi));
 const other=Math.max(0,n(x.other_charges));
 const total=Math.round(freight+unload+moisture+discount+driver+other+quality);
 return {gross_amount:gross,discount_amount:discount,quality_deduct_amount:quality,total_deduction:total,net_payable:Math.max(0,Math.round(gross-total))};
}
