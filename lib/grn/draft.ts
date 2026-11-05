import { purchaseCalc } from '../utils';
import { gstinIsValid, ifscIsValid, type BillPage, type GrnPage, type ParsedDocument } from './parse';

/**
 * Turning a recognised GRN and party bill into a DRAFT purchase (v2.10.0).
 *
 * Nothing here posts anything. It produces a proposal: the fields the existing purchase form
 * accepts, the party it matched (or a party draft to confirm), the duplicates it found, the
 * calculation the approved rules give for those figures, and every point that needs a human
 * decision. The entry is created by the existing POST /api/purchases from the reviewed values, so
 * there is exactly one accounting path and this code never computes a stored total of its own.
 *
 * Two mappings deserve their reasons in writing:
 *
 *  - **Weights.** The bill states what was dispatched (218.90 qtl = 21,890 kg on the sample); the
 *    GRN states what the buyer actually weighed in (21,262 kg). SOLIVY stores both, and
 *    `purchaseCalc` values the purchase on `net_weight`. So the GRN weight is proposed as the net
 *    weight and the bill quantity as the gross, with the difference shown — never silently merged.
 *  - **Moisture.** `purchaseCalc` treats `moisture` as a rupee deduction, not a percentage. The
 *    GRN's "Moist %" is a measurement, and the sample GRN states deductions apply only above
 *    14.00%. The percentage is therefore reported, the deduction is proposed as zero, and the
 *    threshold printed on the document is shown. No deduction rule is invented here.
 */
export type Warning = { code: string; severity: 'info' | 'review' | 'blocking'; message: string };
export type PartyMatch = {
  matched: boolean; party_id: number | null; party_name: string | null; method: string | null;
  confidence: 'high' | 'medium' | 'low'; candidates: Array<{ id: number; name: string; gst: string | null; why: string }>;
  draft: Record<string, any> | null; bank_draft: Record<string, any> | null;
};
export type Duplicate = { kind: string; purchase_id?: number; document_id?: number; detail: string };
export type Draft = {
  purchase: Record<string, any>;
  calculation: ReturnType<typeof purchaseCalc> & { discount_after_quality: number };
  party: PartyMatch;
  broker: { name: string | null; party_id: number | null; matched: boolean };
  warnings: Warning[];
  duplicates: Duplicate[];
  evidence: Record<string, { value: any; confidence: string; note?: string }>;
};

const norm = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The contact line on a bill often prints several numbers ("+91-9179729777 7987200092"). The party
 * form accepts one of 10 to 15 digits, so the first usable number is proposed and the rest are
 * reported rather than concatenated into something that would be rejected or meaningless.
 */
export function phoneNumbers(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(/[\s,;/]+/)
    .map((t) => t.replace(/[^\d+]/g, ''))
    .filter((t) => { const digits = t.replace(/\D/g, ''); return digits.length >= 10 && digits.length <= 15; });
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Match the bill's seller against the organisation's parties: GSTIN first, then name, then alias. */
export function matchParty(d: any, bill: BillPage | null): PartyMatch {
  const empty: PartyMatch = { matched: false, party_id: null, party_name: null, method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null };
  if (!bill) return empty;
  const name = bill.seller_name.value; const gstin = bill.seller_gstin.value;
  const candidates: PartyMatch['candidates'] = [];
  let match: any = null; let method: string | null = null; let confidence: PartyMatch['confidence'] = 'low';

  if (gstin && gstinIsValid(gstin)) {
    const row = d.prepare('SELECT id,name,gst FROM parties WHERE REPLACE(UPPER(COALESCE(gst,\'\')),\' \',\'\')=? AND active=1').get(norm(gstin)) as any;
    if (row) { match = row; method = 'GSTIN'; confidence = 'high'; candidates.push({ id: row.id, name: row.name, gst: row.gst, why: 'Same GSTIN' }); }
  }
  if (!match && name) {
    const target = norm(name);
    for (const row of d.prepare('SELECT id,name,gst FROM parties WHERE active=1').all() as any[]) {
      const n = norm(row.name);
      if (!n || !target) continue;
      if (n === target) { candidates.push({ id: row.id, name: row.name, gst: row.gst, why: 'Same name' }); if (!match) { match = row; method = 'name'; confidence = 'medium'; } }
      else if (n.includes(target) || target.includes(n)) candidates.push({ id: row.id, name: row.name, gst: row.gst, why: 'Similar name' });
    }
  }
  if (!match && name) {
    try {
      const row = d.prepare('SELECT p.id,p.name,p.gst FROM party_aliases a JOIN parties p ON p.id=a.party_id WHERE REPLACE(UPPER(a.alias),\' \',\'\')=?').get(norm(name)) as any;
      if (row) { match = row; method = 'alias'; confidence = 'medium'; candidates.push({ id: row.id, name: row.name, gst: row.gst, why: 'Known alias' }); }
    } catch { /* aliases are optional on older schemas */ }
  }

  // A GSTIN that belongs to a different party than the name match is a decision, not a guess.
  if (match && gstin && gstinIsValid(gstin) && method !== 'GSTIN') {
    const stored = norm((match as any).gst);
    if (stored && stored !== norm(gstin)) confidence = 'low';
  }

  const draft = match ? null : {
    name: name || '', party_type: 'GOODS_VENDOR',
    // A GSTIN that fails its own check digit is left out of the draft rather than carried into
    // the party record: the warning tells the user what was read so they can type the right one.
    gst: gstin && gstinIsValid(gstin) ? gstin : '',
    gst_as_read: gstin || '',
    pan: '',
    address: bill.seller_address.value || '', contact: phoneNumbers(bill.seller_contact.value)[0] || '', email: bill.seller_email.value || '',
    contact_all: phoneNumbers(bill.seller_contact.value),
  };
  // Same rule for the IFSC: an unreadable code is reported, not written into the party's bank
  // details, where it would be used for a payment.
  const ifsc = bill.bank_ifsc.value;
  const bank_draft = match || !(bill.bank_account.value || ifsc) ? null : {
    bank_name: bill.bank_name.value || '', account_number: bill.bank_account.value || '',
    ifsc: ifsc && ifscIsValid(ifsc) ? ifsc : '', ifsc_as_read: ifsc || '',
    account_holder: name || '', is_primary: 1,
  };
  return { matched: Boolean(match), party_id: match?.id ?? null, party_name: match?.name ?? name, method, confidence, candidates: candidates.slice(0, 5), draft, bank_draft };
}

function findDuplicates(d: any, purchase: Record<string, any>, documentSha: string | null): Duplicate[] {
  const out: Duplicate[] = [];
  const add = (kind: string, row: any, detail: string) => { if (row) out.push({ kind, purchase_id: row.id, detail }); };
  if (purchase.sample_no) add('sample_no', d.prepare('SELECT id FROM purchases WHERE sample_no=?').get(String(purchase.sample_no)), `A purchase with sample number ${purchase.sample_no} already exists.`);
  if (purchase.invoice_no && purchase.party_id) add('invoice_no', d.prepare('SELECT id FROM purchases WHERE invoice_no=? AND party_id=?').get(String(purchase.invoice_no), Number(purchase.party_id)), `This party already has a purchase with invoice number ${purchase.invoice_no}.`);
  if (purchase.truck_number && purchase.purchase_date) add('truck_date', d.prepare('SELECT id FROM purchases WHERE truck_number=? AND purchase_date=?').get(String(purchase.truck_number), String(purchase.purchase_date)), `A purchase already exists for vehicle ${purchase.truck_number} on ${purchase.purchase_date}.`);
  if (documentSha) {
    try {
      const prior = d.prepare('SELECT id, purchase_id FROM grn_documents WHERE file_sha256=? AND status<>\'discarded\'').get(documentSha) as any;
      if (prior) out.push({ kind: 'document', document_id: prior.id, purchase_id: prior.purchase_id || undefined, detail: prior.purchase_id ? `This exact document was already used for purchase ${prior.purchase_id}.` : 'This exact document has already been uploaded.' });
    } catch { /* table created with the migration */ }
  }
  return out;
}

export function buildDraft(d: any, parsed: ParsedDocument, opts: { documentSha?: string | null; companyDiscountRule?: number } = {}): Draft {
  const grn: GrnPage | null = parsed.grn; const bill: BillPage | null = parsed.bill;
  const warnings: Warning[] = [];
  const item = bill?.items?.[0] || null;

  if (!grn) warnings.push({ code: 'NO_GRN_PAGE', severity: 'review', message: 'No GRN page was recognised, so the received weight and the GRN date must be entered by hand.' });
  if (!bill) warnings.push({ code: 'NO_BILL_PAGE', severity: 'review', message: 'No party bill was recognised, so the party, the rate and the invoice number must be entered by hand.' });
  if (bill && !item) warnings.push({ code: 'NO_LINE_ITEM', severity: 'review', message: 'The bill was recognised but its goods line could not be read. Enter the quantity and the rate from the page.' });

  // Rate: read the unit off the bill and convert; never assume it is per kilogram.
  let rate: number | null = null;
  if (item) {
    if (item.rate_per_kg !== null) {
      rate = round2(item.rate_per_kg);
      if (item.rate_unit && !/^kgs?\.?$/i.test(item.rate_unit)) warnings.push({ code: 'RATE_CONVERTED', severity: 'info', message: `The bill quotes ${item.rate} per ${String(item.rate_unit).replace(/[^A-Za-z]/g, '')}, which is ₹${rate} per kg. Confirm the unit against the page.` });
    } else {
      warnings.push({ code: 'RATE_UNIT_UNKNOWN', severity: 'blocking', message: `The rate unit on the bill ("${item.rate_unit || 'not read'}") was not recognised, so the per-kg rate cannot be derived. Enter the rate by hand.` });
    }
  }

  // v2.11.0: a unit accepted through a known recognition misreading is never accepted silently.
  if (item?.quantity_unit_corrected || item?.rate_unit_corrected) {
    const which = [item.quantity_unit_corrected ? `the quantity unit as "${item.quantity_unit}"` : '', item.rate_unit_corrected ? `the rate unit as "${item.rate_unit}"` : ''].filter(Boolean).join(' and ');
    warnings.push({ code: 'UNIT_CORRECTED', severity: 'review', message: `Recognition read ${which}, which is not a unit but is a known misreading of one; it has been taken as quintals/kilograms accordingly. Check the unit on the page before saving — the weight and the per-kg rate both depend on it.` });
  }

  const grnWeight = grn?.net_weight_kg.value ?? null;
  const billWeight = item?.quantity_kg ?? null;
  const netWeight = grnWeight ?? billWeight;
  // The dispatched (bill) and received (GRN) weights are distinct figures and one must never be
  // written into the other's field. With no bill page at all there is only the one weight, so it
  // stands for both; but a bill that WAS read and whose quantity could not be converted leaves the
  // gross weight empty and says so, rather than repeating the received weight as if it were the
  // dispatched one.
  const grossWeight = billWeight ?? (bill ? null : grnWeight);
  if (bill && item && billWeight === null) {
    warnings.push({ code: 'DISPATCHED_WEIGHT_UNKNOWN', severity: 'review', message: `The bill's dispatched quantity reads "${item.quantity ?? '?'} ${item.quantity_unit ?? ''}", whose unit was not recognised, so the gross weight is left empty rather than filled in with the received weight. Enter it from the page if your document settings need it.` });
  }
  if (grnWeight !== null && billWeight !== null) {
    const diff = round2(billWeight - grnWeight);
    if (Math.abs(diff) >= 1) warnings.push({ code: 'WEIGHT_DIFFERENCE', severity: 'review', message: `The bill is for ${billWeight} kg and the GRN records ${grnWeight} kg received — a difference of ${diff} kg. The purchase is proposed on the received weight; change it if your contract says otherwise.` });
  }

  if (grn?.moisture_percent.value !== null && grn?.moisture_percent.value !== undefined) {
    const threshold = grn.moisture_threshold_percent.value;
    const pct = grn.moisture_percent.value;
    warnings.push({
      code: 'MOISTURE_REPORTED', severity: 'info',
      message: threshold !== null
        ? `The GRN records ${pct}% moisture and states that losses are deducted above ${threshold}%. ${pct > threshold ? 'That is above the threshold — enter the deduction your contract gives.' : 'No moisture deduction is proposed.'}`
        : `The GRN records ${pct}% moisture. No moisture deduction is proposed; enter one if your contract gives it.`,
    });
  }

  if (bill?.document_type.value === 'BILL_OF_SUPPLY') warnings.push({ code: 'NO_GST', severity: 'info', message: 'This is a bill of supply, so no GST is proposed.' });
  if (bill?.seller_gstin.value && !gstinIsValid(bill.seller_gstin.value)) warnings.push({ code: 'GSTIN_UNCERTAIN', severity: 'review', message: `The seller's GSTIN was read as ${bill.seller_gstin.value}, which fails its check digit. Confirm it against the page before saving a party with it.` });
  if (bill?.bank_ifsc.value && !ifscIsValid(bill.bank_ifsc.value)) warnings.push({ code: 'IFSC_UNCERTAIN', severity: 'review', message: `The IFSC was read as ${bill.bank_ifsc.value}, which is not a valid IFSC. Confirm it before saving bank details.` });
  if (item && item.amount !== null && item.quantity !== null && item.rate !== null) {
    const expected = round2(item.quantity * item.rate);
    if (Math.abs(expected - item.amount) > 1) warnings.push({ code: 'BILL_ARITHMETIC', severity: 'review', message: `The bill's own line does not multiply out: ${item.quantity} × ${item.rate} is ${expected}, but the amount reads ${item.amount}. Check the page.` });
  }

  const party = matchParty(d, bill);
  const contacts = bill ? phoneNumbers(bill.seller_contact.value) : [];
  if (contacts.length > 1) warnings.push({ code: 'MULTIPLE_CONTACTS', severity: 'info', message: `The bill prints ${contacts.length} telephone numbers (${contacts.join(', ')}); the first is proposed for the party.` });
  if (!party.matched) {
    const seller = bill?.seller_name.value;
    warnings.push({
      code: 'PARTY_NOT_FOUND', severity: 'review',
      message: seller
        ? `No existing party matches "${seller}". Review the details read from the bill and create the party, or pick an existing one.`
        : 'No seller was read from the document, so no party could be matched. Choose the party by hand, or create it.',
    });
  }
  else if (party.confidence !== 'high') warnings.push({ code: 'PARTY_UNCERTAIN', severity: 'review', message: `The party was matched by ${party.method} rather than GSTIN. Confirm "${party.party_name}" is right.` });

  const brokerName = bill?.broker.value || null;
  let brokerParty: any = null;
  if (brokerName) {
    const stem = norm(brokerName.replace(/broker/i, ''));
    if (stem) brokerParty = (d.prepare('SELECT id,name FROM parties WHERE active=1').all() as any[]).find((p: any) => norm(p.name).includes(stem)) || null;
    warnings.push({ code: 'BROKER_FOUND', severity: 'info', message: brokerParty ? `The bill names "${brokerName}"; matched to the party "${brokerParty.name}". Confirm before saving.` : `The bill names "${brokerName}" in the delivery-note box, which matches no party here. Leave the broker empty or pick one.` });
  }

  const purchase: Record<string, any> = {
    sample_no: grn?.sample_no.value ?? null,
    purchase_date: grn?.grn_date.value ?? bill?.invoice_date.value ?? null,
    party_id: party.party_id,
    broker_party_id: brokerParty?.id ?? null,
    truck_number: bill?.vehicle_no.value ?? grn?.truck_no.value ?? '',
    goods_description: item?.description ?? '',
    hsn: item?.hsn ?? '',
    invoice_no: bill?.invoice_no.value ?? '',
    bags_qty: grn?.bags.value ?? item?.packages ?? 0,
    gross_weight: grossWeight ?? 0,
    net_weight: netWeight ?? 0,
    rate: rate ?? 0,
    freight: grn?.freight_amount.value ?? 0,
    unload_charge: grn?.load_unload.value ?? 0,
    driver_rokdi: grn?.rokdi.value ?? 0,
    other_charges: 0,
    moisture: 0,                       // a rupee deduction in purchaseCalc; the GRN % is reported above
    discount_pct: 0,
    quality_deduct_per_mt: 0,
    quality_deduct_rate_per_kg: 0,
    gst_type: bill?.document_type.value === 'BILL_OF_SUPPLY' ? 'NONE' : 'NONE',
    gst_rate: 0,
    gst_taxable: 0,
  };

  const discountRule = Number(opts.companyDiscountRule ?? 1) === 0 ? 0 : 1;
  const calculation = { ...purchaseCalc({ ...purchase, discount_after_quality: discountRule }), discount_after_quality: discountRule };

  if (item?.amount !== null && item?.amount !== undefined && calculation.gross_amount && Math.abs(item.amount - calculation.gross_amount) > 1) {
    warnings.push({ code: 'BILL_VS_RECEIVED', severity: 'info', message: `The bill totals ₹${item.amount} for the dispatched quantity; valuing the received weight at the same rate gives ₹${calculation.gross_amount}.` });
  }
  if (!purchase.party_id) warnings.push({ code: 'PARTY_REQUIRED', severity: 'blocking', message: 'A party must be chosen or created before the purchase can be saved.' });
  if (!purchase.purchase_date || !purchase.net_weight || !purchase.rate) warnings.push({ code: 'REQUIRED_FIELDS', severity: 'blocking', message: 'Date, net weight and rate are required by the purchase form; fill in whatever could not be read.' });
  if (!String(purchase.truck_number || '').trim()) warnings.push({ code: 'TRUCK_REQUIRED', severity: 'blocking', message: 'The purchase form requires a vehicle number.' });

  const evidence: Draft['evidence'] = {};
  const put = (key: string, f: any) => { if (f) evidence[key] = { value: f.value, confidence: f.confidence, note: f.note }; };
  if (grn) { put('grn.sample_no', grn.sample_no); put('grn.date', grn.grn_date); put('grn.truck_no', grn.truck_no); put('grn.bags', grn.bags); put('grn.net_weight_kg', grn.net_weight_kg); put('grn.moisture_percent', grn.moisture_percent); put('grn.freight', grn.freight_amount); put('grn.load_unload', grn.load_unload); put('grn.rokdi', grn.rokdi); put('grn.party_code', grn.party_code); }
  if (bill) { put('bill.seller_name', bill.seller_name); put('bill.seller_gstin', bill.seller_gstin); put('bill.invoice_no', bill.invoice_no); put('bill.invoice_date', bill.invoice_date); put('bill.vehicle_no', bill.vehicle_no); put('bill.broker', bill.broker); put('bill.total_amount', bill.total_amount); put('bill.bank_account', bill.bank_account); put('bill.bank_ifsc', bill.bank_ifsc); }
  if (item) evidence['bill.line_item'] = { value: `${item.packages ?? '?'} pkgs · ${item.description} · HSN ${item.hsn} · ${item.quantity} ${item.quantity_unit} @ ${item.rate} per ${item.rate_unit} = ${item.amount}`, confidence: 'medium', note: item.source };

  return { purchase, calculation, party, broker: { name: brokerName, party_id: brokerParty?.id ?? null, matched: Boolean(brokerParty) }, warnings, duplicates: findDuplicates(d, purchase, opts.documentSha ?? null), evidence };
}
