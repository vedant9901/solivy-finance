import { n } from './utils';
import type { Mode } from './db';

export type TdsDecision = {
  applicable: boolean;
  rate: number;
  base: number;
  amount: number;
  rule: string;
  section: string;
  reason: string;
  act: string;
  review: boolean;
};

function fyStart(date: string) {
  const d = new Date(`${date}T00:00:00`);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

function noTds(reason: string, review = false): TdsDecision {
  return { applicable: false, rate: 0, base: 0, amount: 0, rule: 'NO TDS', section: '', reason, act: 'Income-tax Act, 2025', review };
}

function actInfo(date: string) {
  if (date < '2026-04-01') return { act: 'Income-tax Act, 1961', suffix: 'old Act' };
  return { act: 'Income-tax Act, 2025', suffix: 'Section 393' };
}

/**
 * Compliance assistant for common resident-payee TDS cases.
 * It deliberately returns REVIEW for facts that cannot safely be inferred from a party name alone.
 */
export async function decideTds(d: any, party: any, paymentDate: string, amount: number): Promise<TdsDecision> {
  const amt = Math.max(0, Math.round(n(amount)));
  if (!party) return noTds('Select a party first.');
  if (party.tds_exempt) return noTds('Party is marked exempt / lower or nil deduction certificate.', true);
  if (party.resident_status !== 'RESIDENT') return noTds('Non-resident payment requires separate withholding / remittance review.', true);
  const settings = await d.prepare('SELECT * FROM company_settings WHERE id=1').get() as any || {};
  const info = actInfo(paymentDate);
  const noPan = !party.pan || party.pan_status !== 'VALID';
  const higherRate = (normal: number) => noPan ? 20 : normal;
  const start = fyStart(paymentDate);
  const qualifiedGeneral = ['COMPANY','FIRM','LLP','GOVERNMENT'].includes(String(settings.deductor_type || '').toUpperCase());
  const turnover = n(settings.preceding_turnover);
  const priorPayments = n((await d.prepare("SELECT COALESCE(SUM(amount),0) total FROM payments WHERE party_id=? AND payment_date>=? AND payment_date<? AND status='POSTED'").get(party.id, start, paymentDate) as any)?.total);

  if (party.party_type === 'GOODS_VENDOR') {
    // 194Q / corresponding 2025 Act provision: buyer turnover > ₹10 crore and aggregate purchases > ₹50 lakh.
    if (turnover <= 100000000) return noTds('Goods-purchase TDS is not triggered because preceding-year buyer turnover is not above ₹10 crore.');
    const purchased = n((await d.prepare("SELECT COALESCE(SUM(net_payable),0) total FROM purchases WHERE party_id=? AND status='POSTED' AND purchase_date>=? AND purchase_date<=?").get(party.id, start, paymentDate) as any)?.total);
    const priorTdsBase = n((await d.prepare("SELECT COALESCE(SUM(tds_base),0) base FROM payments WHERE party_id=? AND payment_date>=? AND payment_date<? AND status='POSTED'").get(party.id, start, paymentDate) as any)?.base);
    const thresholdExcess = Math.max(0, purchased - 5000000 - priorTdsBase);
    const base = Math.min(amt, thresholdExcess);
    if (base <= 0) return noTds(`Goods purchases have not crossed ₹50 lakh for this party (aggregate recorded purchases ₹${purchased.toLocaleString('en-IN')}).`);
    const rate = higherRate(0.1);
    return { applicable: true, rate, base, amount: Math.round(base * rate / 100), rule: noPan ? 'Goods purchase — PAN not valid/available; higher-rate check' : 'Goods purchase — aggregate purchases above ₹50 lakh', section: info.act === 'Income-tax Act, 2025' ? 'Section 393 — corresponding goods-purchase table item' : 'Section 194Q', reason: `Buyer preceding-year turnover ₹${turnover.toLocaleString('en-IN')} and aggregate purchases crossed ₹50 lakh.`, act: info.act, review: noPan };
  }

  if (party.party_type === 'CONTRACTOR') {
    if (!qualifiedGeneral) return noTds('Contractor TDS needs confirmation that the payer is a specified person liable to deduct under the contractor provision.', true);
    const single = amt > 30000;
    const aggregate = priorPayments + amt > 100000;
    if (!single && !aggregate) return noTds(`Contractor threshold not crossed: current ₹${amt.toLocaleString('en-IN')}, FY aggregate before this payment ₹${priorPayments.toLocaleString('en-IN')}.`);
    const normal = ['INDIVIDUAL','HUF'].includes(String(party.entity_type)) ? 1 : 2;
    const rate = higherRate(normal);
    return { applicable: true, rate, base: amt, amount: Math.round(amt * rate / 100), rule: noPan ? 'Contractor — PAN higher-rate check' : 'Contractor — threshold crossed', section: info.act === 'Income-tax Act, 2025' ? 'Section 393 — contractor table item' : 'Section 194C', reason: 'Contractor payment threshold crossed.', act: info.act, review: noPan };
  }

  if (party.party_type === 'COMMISSION') {
    if (!qualifiedGeneral) return noTds('Commission/brokerage TDS needs confirmation that the payer is a specified person.', true);
    if (priorPayments + amt <= 20000) return noTds(`Commission/brokerage threshold not crossed: FY aggregate ₹${(priorPayments + amt).toLocaleString('en-IN')}.`);
    const rate = higherRate(2);
    return { applicable: true, rate, base: amt, amount: Math.round(amt * rate / 100), rule: noPan ? 'Commission/brokerage — PAN higher-rate check' : 'Commission/brokerage threshold crossed', section: info.act === 'Income-tax Act, 2025' ? 'Section 393 — commission/brokerage table item' : 'Section 194H', reason: 'FY commission/brokerage threshold crossed.', act: info.act, review: noPan };
  }

  if (party.party_type === 'PROFESSIONAL') {
    if (!qualifiedGeneral) return noTds('Professional-fee TDS needs confirmation that the payer is a specified person; individual/HUF payer eligibility depends on preceding-year business/profession turnover.', true);
    if (priorPayments + amt <= 50000) return noTds(`Professional-fee threshold not crossed: FY aggregate ₹${(priorPayments + amt).toLocaleString('en-IN')}.`);
    const rate = higherRate(10);
    return { applicable: true, rate, base: amt, amount: Math.round(amt * rate / 100), rule: noPan ? 'Professional fee — PAN higher-rate check' : 'Professional fee threshold crossed', section: info.act === 'Income-tax Act, 2025' ? 'Section 393 — professional-fee table item' : 'Section 194J', reason: 'FY professional-fee threshold crossed.', act: info.act, review: noPan };
  }

  if (party.party_type === 'INTEREST') {
    if (!qualifiedGeneral) return noTds('Interest TDS needs payer/payee-specific review before automatic deduction.', true);
    if (priorPayments + amt <= 10000) return noTds(`Interest threshold not crossed under the configured general rule: FY aggregate ₹${(priorPayments + amt).toLocaleString('en-IN')}.`, true);
    const rate = higherRate(10);
    return { applicable: true, rate, base: amt, amount: Math.round(amt * rate / 100), rule: noPan ? 'Interest — PAN higher-rate check' : 'Interest threshold crossed', section: info.act === 'Income-tax Act, 2025' ? 'Section 393 — interest table item' : 'Section 194A', reason: 'Interest payment requires withholding under the configured resident-payee rule.', act: info.act, review: noPan };
  }

  if (party.party_type === 'RENT') {
    return noTds('Rent TDS depends on property type and payer category. Select the rent category and confirm applicability before posting.', true);
  }

  if (party.tds_enabled && n(party.tds_rate) > 0) {
    return { applicable: true, rate: n(party.tds_rate), base: amt, amount: Math.round(amt * n(party.tds_rate) / 100), rule: 'CA / approved party configuration', section: party.tds_section || '', reason: 'Manual rate is being used because the party is configured for it.', act: info.act, review: true };
  }
  return noTds('No automatic TDS category is configured for this party.');
}
