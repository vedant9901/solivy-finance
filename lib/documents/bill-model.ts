/**
 * Commercial / third-party / purchase bill DOCUMENT MODEL (v2.7.0).
 * One source of truth for what a bill shows, shared by every template, so totals are identical
 * whatever template is selected. Nothing here recalculates or modifies the stored purchase.
 *
 * Deductions follow the stored purchase values, and moisture is presented by lib/documents/moisture.ts
 * (v2.7.3): the percentage appears in the label, the money in the amount column, never the other way
 * round. One moisture row only, so nothing is deducted twice:
 *  - Rate-per-kg quality rule (quality_deduct_rate_per_kg > 0): the quality deduction IS the moisture
 *    deduction → "Less: Moisture Deduction (20%)" carrying that amount.
 *  - Per-MT rule: the stored moisture value is what the calculation deducted → the same row carries
 *    it, with the entered percentage in the label, and quality is listed separately.
 *    (v2.6.30 printed the quality amount as moisture and dropped the rupee moisture amount whenever
 *    both were present, so the printed total did not equal net payable.)
 * The printed total = gross − deductions shown. With every deduction enabled it equals net payable.
 */
export type BillSettings = Record<string, any>;
export type Deduction = { label: string; amount: number; key: string };
export type BillModel = {
  kind: 'commercial' | 'third-party'; title: string;
  company: { name: string; lines: string[] }; companyBank: string[];
  buyer: { name: string; lines: string[] }; broker: string[];
  meta: Array<[string, string]>;
  columns: Array<{ key: string; label: string; value: string; weight: number; align?: 'left' | 'right' }>;
  description: string; bags: string; quantityText: string;
  gross: number; deductions: Deduction[]; total: number; netPayable: number; totalMatchesNetPayable: boolean;
  amountWords: string; show: { amountWords: boolean; declaration: boolean; signature: boolean; bank: boolean; headerDate: string };
  fileBase: string;
};

import { moistureDisplay } from './moisture';

const clean = (v: any) => String(v ?? '').trim();
const inr = (v: any) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kg = (v: any) => Math.round(Number(v || 0)).toLocaleString('en-IN');
export function bool(s: BillSettings, key: string, def = true) { return s?.[key] === undefined ? def : !!s[key]; }
export function dateText(v: any) {
  const iso = clean(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return clean(v);
  return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
export function wordsINR(n: number) {
  n = Math.round(Math.abs(n));
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const under = (x: number): string => x < 20 ? ones[x] : x < 100 ? tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '') : ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + under(x % 100) : '');
  const big = (x: number): string => { if (x === 0) return ''; const c = Math.floor(x / 1e7); x %= 1e7; const l = Math.floor(x / 1e5); x %= 1e5; const t = Math.floor(x / 1e3); x %= 1e3; return [c ? `${big(c)} Crore` : '', l ? `${under(l)} Lakh` : '', t ? `${under(t)} Thousand` : '', x ? under(x) : ''].filter(Boolean).join(' '); };
  return n === 0 ? 'Zero' : big(n);
}

/** The deduction rows a bill prints and the resulting total (shared by all templates). */
export function billDeductions(row: any, s: BillSettings, kind: 'commercial' | 'third-party') {
  const m = moistureDisplay(row);
  const quality = Number(row.quality_deduct_amount || 0);
  const rows: Array<[string, number, string, boolean]> = [
    ['Unload Charges', Number(row.unload_charge || 0), 'include_unload', false],
    ['Driver Rokdi', Number(row.driver_rokdi || 0), 'include_driver_rokdi', false],
    ['Freight', Number(row.freight || 0), 'include_freight', false],
  ];
  if (m.perKgRule) {
    // The quality deduction is the moisture deduction under this rule: one row, never both.
    if (m.percent > 0) rows.push([m.label, m.amount, 'include_moisture', true]);
    else rows.push(['Quality Deduct', quality, 'include_quality_deduct', false]);
  } else {
    if (m.show) rows.push([m.label, m.amount, 'include_moisture', false]);
    rows.push(['Quality Deduct', quality, 'include_quality_deduct', false]);
  }
  rows.push(['Discount', Number(row.discount_amount || 0), 'include_discount', false]);
  rows.push(['Other Charges', Number(row.other_charges || 0), 'include_other_charges', false]);
  const show = kind !== 'third-party' || bool(s, 'show_deductions', true);
  const deductions: Deduction[] = show ? rows.filter(([, v, k, force]) => bool(s, k, true) && (force || v !== 0)).map(([label, amount, key]) => ({ label, amount, key })) : [];
  const gross = Number(row.gross_amount || 0);
  const total = Math.max(0, Math.round(gross - deductions.reduce((a, x) => a + x.amount, 0)));
  return { gross, deductions, total };
}

export function buildBillModel(input: { row: any; company: any; companyBank: any; toParty: any; settings: BillSettings; kind: 'commercial' | 'third-party' }): BillModel {
  const { row, company, companyBank, toParty, settings: s, kind } = input;
  const legacyCombined = s.combine_sample_date ?? s.combine_sample_no_date ?? s.show_sample_no_date_together;
  const combine = s.show_sample_date_together !== undefined ? !!s.show_sample_date_together : (legacyCombined !== undefined ? !!legacyCombined : kind === 'third-party');
  const date = dateText(row.purchase_date) || dateText(row.created_at);
  const sampleNo = (combine || bool(s, 'show_sample_no')) ? clean(row.sample_no) : '';
  const meta: Array<[string, string]> = [];
  if (bool(s, 'show_bill_number', true) && Number(row.bill_number || row.id) > 0) meta.push(['Bill No.', String(row.bill_number || row.id)]);
  if (bool(s, 'show_invoice_no') && clean(row.invoice_no)) meta.push(['Invoice No.', clean(row.invoice_no)]);
  if (combine) { const sd = [sampleNo, bool(s, 'show_date', true) ? date : ''].filter(Boolean).join(' / '); if (sd) meta.push(['Sample No. / Date', sd]); }
  else { if (bool(s, 'show_date', true) && date) meta.push(['Dated', date]); if (sampleNo) meta.push(['Sample No.', sampleNo]); }
  // Truck Number is printed directly below Sample No. / Date (or Sample No.) when enabled.
  if (bool(s, 'show_truck_number') && clean(row.truck_number)) meta.push(['Truck No.', clean(row.truck_number)]);
  if (bool(s, 'show_payment_terms') && Number(row.payment_due_days) > 0) meta.push(['Mode/Terms of Payment', `Due after ${Number(row.payment_due_days)} days`]);

  const companyLines = [
    ...(bool(s, 'show_company_address') ? [company.address, company.city, company.state].map(clean).filter(Boolean) : []),
    bool(s, 'show_company_gst') && clean(company.gstin) ? `GSTIN : ${company.gstin}` : '',
    bool(s, 'show_company_pan') && clean(company.pan) ? `PAN : ${company.pan}` : '',
    bool(s, 'show_company_email') && clean(company.email) ? `E-Mail : ${company.email}` : '',
  ].filter(Boolean);
  const buyerLines = [bool(s, 'show_party_address', true) ? clean(toParty.address) : '', bool(s, 'show_party_contact') && toParty.contact ? `Contact : ${toParty.contact}` : '', bool(s, 'show_party_gst') && toParty.gst ? `GSTIN : ${toParty.gst}` : '', bool(s, 'show_party_pan') && toParty.pan ? `PAN : ${toParty.pan}` : ''].filter(Boolean);
  const broker = row.broker_party_name ? [`Broker: ${row.broker_party_name}`, row.broker_contact ? `Broker Contact: ${row.broker_contact}` : '', row.broker_email ? `Broker Email: ${row.broker_email}` : ''].filter(Boolean) : [];

  const net = Number(row.net_weight || 0), gw = Number(row.gross_weight || 0);
  const columns: BillModel['columns'] = [{ key: 'sl', label: 'Sl No.', value: '1', weight: 8 }, { key: 'description', label: 'Description of Goods', value: clean(row.goods_description) || clean(row.notes), weight: 36 }];
  if (bool(s, 'show_hsn') && clean(row.hsn)) columns.push({ key: 'hsn', label: 'HSN/SAC', value: clean(row.hsn), weight: 12 });
  if (bool(s, 'show_quantity') && net > 0) columns.push({ key: 'quantity', label: 'Quantity', value: `${kg(net)} Kg`, weight: 15 });
  if (bool(s, 'show_net_weight') && net > 0) columns.push({ key: 'net', label: 'Net Weight', value: `${kg(net)} Kg`, weight: 14 });
  if (bool(s, 'show_gross_weight') && gw > 0) columns.push({ key: 'gross', label: 'Gross Weight', value: `${kg(gw)} Kg`, weight: 14 });
  if (bool(s, 'show_rate') && Number(row.rate) > 0) columns.push({ key: 'rate', label: 'Rate', value: inr(row.rate), weight: 12 });
  if (bool(s, 'show_amount') && row.gross_amount !== null && row.gross_amount !== undefined) columns.push({ key: 'amount', label: 'Amount', value: inr(row.gross_amount), weight: 16, align: 'right' });

  const { gross, deductions, total } = billDeductions(row, s, kind);
  const bank = bool(s, 'show_bank_details') ? [companyBank?.account_holder ? `A/c Holder's Name : ${companyBank.account_holder}` : '', companyBank?.bank_name ? `Bank Name : ${companyBank.bank_name}` : '', companyBank?.account_number ? `A/c No. : ${companyBank.account_number}` : '', companyBank?.branch || companyBank?.ifsc ? `Branch & IFS Code : ${[companyBank?.branch, companyBank?.ifsc].filter(Boolean).join(' & ')}` : ''].filter(Boolean) : [];
  return {
    kind, title: 'INVOICE',
    company: { name: bool(s, 'show_company_name', true) ? clean(company.name) || 'SOLIVY' : '', lines: companyLines }, companyBank: bank,
    buyer: { name: bool(s, 'show_buyer_name', true) ? clean(toParty.name) : '', lines: buyerLines }, broker,
    meta, columns, description: clean(row.goods_description) || clean(row.notes), bags: Number(row.bags_qty) > 0 ? `${kg(row.bags_qty)} Bags` : '', quantityText: net > 0 ? `${kg(net)} Kg` : '',
    gross, deductions, total, netPayable: Number(row.net_payable || 0), totalMatchesNetPayable: Math.round(total) === Math.round(Number(row.net_payable || 0)),
    amountWords: `INR ${wordsINR(total)} Only`,
    show: { amountWords: bool(s, 'show_amount_words', true), declaration: bool(s, 'show_declaration'), signature: bool(s, 'show_signature'), bank: bank.length > 0, headerDate: bool(s, 'show_date', true) && !combine ? date : '' },
    fileBase: (clean(row.invoice_no) || clean(row.sample_no) || `purchase-${row.id}`).replace(/[^A-Za-z0-9_-]/g, '_'),
  };
}
