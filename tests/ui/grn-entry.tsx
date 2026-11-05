import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import GrnImportWizard from '../../app/components/GrnImportWizard';

/**
 * Mounts the wizard the Add Purchase modal opens, with /api/grn stubbed so each response shape can
 * be exercised in a real browser: `#ok` a complete extraction, `#nodraft` the failure shape that
 * produced the reported crash, `#malformed` a response that is not an object at all.
 */
const purchaseCalcSample = { net_weight: 21262, rate: 20 };
const RESPONSES: Record<string, { status: number; body: any }> = {
  ok: {
    status: 200,
    body: {
      ok: true, document_id: 11, file_name: 'VRHUF-DEEPAKTRA-17.10.pdf', original_kept: true,
      extraction: {
        source: 'ocr', page_count: 2, notes: ['Recognised on this machine from the page images, by the OCR engine built into SOLIVY; nothing was sent anywhere.'], tools: {}, ms: 9400,
        pages: [{ page: 1, source: 'ocr' }, { page: 2, source: 'ocr' }],
        engine: { kind: 'bundled-wasm', version: '5.1.0-288-g2a9c1', path: '/app/vendor/tesseract-wasm/tesseract-core-lstm.wasm.js', tessdata: '/app/vendor/tesseract-wasm/tessdata', languages: ['eng'], language_requested: 'eng', psm: 4, reason: null },
        diagnostics: [
          { page: 1, status: 'recognised', engine: 'bundled-wasm', ms: 4100, chars: 926, confidence: 85, detail: null },
          { page: 2, status: 'recognised', engine: 'bundled-wasm', ms: 5300, chars: 1476, confidence: 69, detail: null },
        ],
      },
      recognised: { grn: true, bill: true, grn_page: 1, bill_page: 2, unrecognised_pages: [] },
      link: { linked: true, confidence: 'high', reasons: ['Vehicle tail matches.'] },
      parsed: { grn: null, bill: null },
      draft: {
        purchase: { ...purchaseCalcSample, sample_no: '2627-22603', purchase_date: '2026-10-17', truck_number: 'GJ04X5630', invoice_no: '274', hsn: '10059000', goods_description: 'Maize', bags_qty: 375, gross_weight: 21890, freight: 0, unload_charge: 0, driver_rokdi: 0, other_charges: 0, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, gst_type: 'NONE', gst_rate: 0, gst_taxable: 0, party_id: null },
        calculation: { gross_amount: 425240, discount_amount: 0, quality_deduct_amount: 0, discount_base_amount: 425240, total_deduction: 0, net_payable: 425240, discount_after_quality: 1 },
        party: { matched: false, party_id: null, party_name: 'Deepak Enterprises', method: null, confidence: 'low', candidates: [], draft: { name: 'Deepak Enterprises' }, bank_draft: null },
        broker: { name: 'Shyam Broker', party_id: null, matched: false },
        warnings: [{ code: 'RATE_CONVERTED', severity: 'info', message: 'The bill quotes 2000 per qtl, which is ₹20 per kg.' }, { code: 'PARTY_REQUIRED', severity: 'blocking', message: 'A party must be chosen before the purchase can be saved.' }],
        duplicates: [{ kind: 'sample_no', detail: 'A purchase with sample number 2627-22603 already exists.' }],
        evidence: {
          'grn.sample_no': { value: '2627-22603', confidence: 'high', note: '2627-22603 17.10.2026' },
          'grn.net_weight_kg': { value: 21262, confidence: 'medium', note: '375 21890 21262' },
          'bill.invoice_no': { value: '274', confidence: 'medium', note: '274 13-Oct-26' },
        },
      },
    },
  },
  nodraft: { status: 422, body: { ok: false, error: 'No text could be read from this PDF on this machine.', extraction: { source: 'none', page_count: 3, notes: ['tesseract was not found.'], tools: { tesseract: null }, pages: [] } } },
  malformed: { status: 200, body: 'not json at all' },
  // v2.12.0: a consignment list of three rows, each its own GRN with its own draft.
  multi: {
    status: 200,
    body: {
      ok: true, document_id: 21, file_name: 'S M CORPORATION.pdf', original_kept: true,
      extraction: { source: 'ocr', page_count: 5, viewable_pages: [1, 2, 3, 4, 5], native: true, notes: [], tools: {}, ms: 42000,
        pages: [{ page: 1, source: 'ocr' }], diagnostics: [], engine: { kind: 'bundled-wasm', version: '5.1.0', path: null, tessdata: null, languages: ['eng'], language_requested: 'eng', psm: 4, reason: null, load_route: 'require', load_attempts: [] } },
      recognised: { grn: true, bill: true, grn_page: 1, bill_page: 2, unrecognised_pages: [] },
      link: { linked: true, confidence: 'high', reasons: [] },
      parsed: { grn: null, bill: null },
      page_classifications: [
        { page: 1, kind: 'grn-list', title: 'Goods receipt list', confidence: 'high', evidence: ['3 consignment row(s) before the total'] },
        { page: 2, kind: 'tax-invoice', title: 'Tax invoice', confidence: 'high', evidence: [] },
        { page: 3, kind: 'bill-of-supply', title: 'Bill of supply', confidence: 'high', evidence: [] },
        { page: 4, kind: 'receipt', title: 'Handwritten or stamped slip', confidence: 'low', evidence: [] },
        { page: 5, kind: 'unknown', title: 'Not recognised', confidence: 'low', evidence: [] }
      ],
      documents: [
        { page: 2, kind: 'tax-invoice', bill: { page: 2, seller_name: 'PITAMBARA TRADING', gstin: '23AAAAA0000A1Z5', invoice_no: '42', invoice_date: '2026-10-22', vehicle_no: 'MP09HH0139', total_amount: 837237.5, round_off: 0.5, columns: ['description', 'packages', 'quantity', 'rate', 'amount'], warnings: [],
          lines: [{ line: 1, description: 'Maize', hsn: '100500', packages: 590, quantity: 304.45, quantity_unit: 'QTL', rate: 2750, rate_unit: 'QTL', amount: 837237.5, calculated_check: 2750, warnings: [], raw: '' }] } },
        { page: 3, kind: 'bill-of-supply', bill: { page: 3, seller_name: 'LAXMI TRADERS', gstin: null, invoice_no: null, invoice_date: null, vehicle_no: null, total_amount: null, round_off: null, columns: ['description', 'hsn', 'quantity', 'amount'], warnings: [],
          lines: [{ line: 1, description: 'Makka', hsn: '10059000', packages: null, quantity: 340.45, quantity_unit: null, rate: null, rate_unit: null, amount: 987305, calculated_check: 2900, warnings: [{ code: 'RATE_COLUMN_ABSENT', severity: 'review', message: 'No rate column was found in this bill.' }], raw: '' }] } }
      ],
      matches: [
        { document_page: 2, grn_id: 'p1r1', score: 110, confidence: 'high', evidence: ['the vehicle number ends 0139', '590 bags on both'], conflicts: [], alternatives: [] },
        { document_page: 3, grn_id: null, score: 20, confidence: 'low', evidence: [], conflicts: ['no vehicle number on the bill'], alternatives: [] }
      ],
      totals: { printed: { bags: 1900, net_weight_kg: 100000 }, summed: { bags: 1890, net_weight_kg: 100000 },
        differences: [{ column: 'bags', printed: 1900, summed: 1890, difference: -10 }], raw: 'Total 1,900 100000' },
      counts: { pages: 5, list_pages: 1, rows_detected: 3, rows_extracted: 3, rows_unresolved: 0, documents: 2, goods_lines: 2, unmatched_documents: 1, unmatched_rows: 2, pages_unclassified: 1 },
      grns: [
        { id: 'p1r1', page: 1, row: 1, document_page: 2, raw: 'row 1',
      sample_no: { value: '2627-23766', confidence: 'high', source: '' }, grn_date: { value: '2026-10-21', confidence: 'high', source: '' },
      truck_no: { value: '0139', confidence: 'medium', source: '' }, supplier_name: { value: 'PITAMBARA TRADING', confidence: 'medium', source: '' },
      bags: { value: 590, confidence: 'medium', source: '' }, net_weight_kg: { value: 30135, confidence: 'medium', source: '' },
      freight_amount: { value: 0, confidence: 'medium', source: '' }, load_unload: { value: 590, confidence: 'medium', source: '' },
      rokdi: { value: 455, confidence: 'medium', source: '' }, moisture_percent: { value: 19.5, confidence: 'medium', source: '' },
      deduction_amount: { value: 2787.49, confidence: 'medium', source: '' },
      warnings: [],
      draft: { purchase: { sample_no: '2627-23766', purchase_date: '2026-10-21', truck_number: '0139', net_weight: 30135, rate: 27.5, bags_qty: 590, gross_weight: 0, freight: 0, unload_charge: 590, driver_rokdi: 455, other_charges: 0, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, gst_type: 'NONE', gst_rate: 0, gst_taxable: 0, invoice_no: '5', goods_description: 'Maize', hsn: '100500', party_id: null },
        calculation: { gross_amount: 30135 * 27.5, discount_amount: 0, quality_deduct_amount: 0, discount_base_amount: 0, total_deduction: 0, net_payable: 30135 * 27.5, discount_after_quality: 1 },
        party: { matched: false, party_id: null, party_name: 'PITAMBARA TRADING', method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null },
        broker: { name: null, party_id: null, matched: false },
        warnings: [{ code: 'PARTY_REQUIRED', severity: 'blocking', message: 'A party must be chosen before the purchase can be saved.' }],
        duplicates: [], evidence: {} } },
        { id: 'p1r2', page: 1, row: 2, document_page: null, raw: 'row 2',
      sample_no: { value: '2627-23720', confidence: 'high', source: '' }, grn_date: { value: '2026-10-22', confidence: 'high', source: '' },
      truck_no: { value: '3979', confidence: 'medium', source: '' }, supplier_name: { value: 'PITAMBAR TRADI', confidence: 'medium', source: '' },
      bags: { value: 720, confidence: 'medium', source: '' }, net_weight_kg: { value: 36240, confidence: 'medium', source: '' },
      freight_amount: { value: 0, confidence: 'medium', source: '' }, load_unload: { value: 720, confidence: 'medium', source: '' },
      rokdi: { value: 455, confidence: 'medium', source: '' }, moisture_percent: { value: 14.2, confidence: 'medium', source: '' },
      deduction_amount: { value: 72.48, confidence: 'medium', source: '' },
      warnings: [{ code: 'ROW_WRAPPED', severity: 'info', message: 'Some of this row is printed on the line beneath it.' }],
      draft: { purchase: { sample_no: '2627-23720', purchase_date: '2026-10-22', truck_number: '3979', net_weight: 36240, rate: 27.5, bags_qty: 720, gross_weight: 0, freight: 0, unload_charge: 720, driver_rokdi: 455, other_charges: 0, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, gst_type: 'NONE', gst_rate: 0, gst_taxable: 0, invoice_no: '6', goods_description: 'Maize', hsn: '100500', party_id: null },
        calculation: { gross_amount: 36240 * 27.5, discount_amount: 0, quality_deduct_amount: 0, discount_base_amount: 0, total_deduction: 0, net_payable: 36240 * 27.5, discount_after_quality: 1 },
        party: { matched: false, party_id: null, party_name: 'PITAMBAR TRADI', method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null },
        broker: { name: null, party_id: null, matched: false },
        warnings: [{ code: 'PARTY_REQUIRED', severity: 'blocking', message: 'A party must be chosen before the purchase can be saved.' }],
        duplicates: [], evidence: {} } },
        { id: 'p1r3', page: 1, row: 3, document_page: null, raw: 'row 3',
      sample_no: { value: '2627-24234', confidence: 'high', source: '' }, grn_date: { value: '2026-10-23', confidence: 'high', source: '' },
      truck_no: { value: '5386', confidence: 'medium', source: '' }, supplier_name: { value: 'KUSHAL ENTERPRISES', confidence: 'medium', source: '' },
      bags: { value: 495, confidence: 'medium', source: '' }, net_weight_kg: { value: 24472, confidence: 'medium', source: '' },
      freight_amount: { value: 0, confidence: 'medium', source: '' }, load_unload: { value: 495, confidence: 'medium', source: '' },
      rokdi: { value: 455, confidence: 'medium', source: '' }, moisture_percent: { value: 20, confidence: 'medium', source: '' },
      deduction_amount: { value: 2508.38, confidence: 'medium', source: '' },
      warnings: [],
      draft: { purchase: { sample_no: '2627-24234', purchase_date: '2026-10-23', truck_number: '5386', net_weight: 24472, rate: 27.5, bags_qty: 495, gross_weight: 0, freight: 0, unload_charge: 495, driver_rokdi: 455, other_charges: 0, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, gst_type: 'NONE', gst_rate: 0, gst_taxable: 0, invoice_no: '7', goods_description: 'Maize', hsn: '100500', party_id: null },
        calculation: { gross_amount: 24472 * 27.5, discount_amount: 0, quality_deduct_amount: 0, discount_base_amount: 0, total_deduction: 0, net_payable: 24472 * 27.5, discount_after_quality: 1 },
        party: { matched: false, party_id: null, party_name: 'KUSHAL ENTERPRISES', method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null },
        broker: { name: null, party_id: null, matched: false },
        warnings: [{ code: 'PARTY_REQUIRED', severity: 'blocking', message: 'A party must be chosen before the purchase can be saved.' }],
        duplicates: [], evidence: {} } }
      ],
      draft: { id: 'p1r1', page: 1, row: 1, document_page: 2, raw: 'row 1',
      sample_no: { value: '2627-23766', confidence: 'high', source: '' }, grn_date: { value: '2026-10-21', confidence: 'high', source: '' },
      truck_no: { value: '0139', confidence: 'medium', source: '' }, supplier_name: { value: 'PITAMBARA TRADING', confidence: 'medium', source: '' },
      bags: { value: 590, confidence: 'medium', source: '' }, net_weight_kg: { value: 30135, confidence: 'medium', source: '' },
      freight_amount: { value: 0, confidence: 'medium', source: '' }, load_unload: { value: 590, confidence: 'medium', source: '' },
      rokdi: { value: 455, confidence: 'medium', source: '' }, moisture_percent: { value: 19.5, confidence: 'medium', source: '' },
      deduction_amount: { value: 2787.49, confidence: 'medium', source: '' },
      warnings: [],
      draft: { purchase: { sample_no: '2627-23766', purchase_date: '2026-10-21', truck_number: '0139', net_weight: 30135, rate: 27.5, bags_qty: 590, gross_weight: 0, freight: 0, unload_charge: 590, driver_rokdi: 455, other_charges: 0, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, gst_type: 'NONE', gst_rate: 0, gst_taxable: 0, invoice_no: '5', goods_description: 'Maize', hsn: '100500', party_id: null },
        calculation: { gross_amount: 30135 * 27.5, discount_amount: 0, quality_deduct_amount: 0, discount_base_amount: 0, total_deduction: 0, net_payable: 30135 * 27.5, discount_after_quality: 1 },
        party: { matched: false, party_id: null, party_name: 'PITAMBARA TRADING', method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null },
        broker: { name: null, party_id: null, matched: false },
        warnings: [{ code: 'PARTY_REQUIRED', severity: 'blocking', message: 'A party must be chosen before the purchase can be saved.' }],
        duplicates: [], evidence: {} } }.draft,
    },
  },

  // v2.10.2: the machine with no recognition engine. The pages were read and can be shown, the
  // draft is complete and empty, and the values are typed in from the page.
  manual: {
    status: 200,
    body: {
      ok: true, manual_entry: true, document_id: 12, file_name: 'scan.pdf', original_kept: true,
      extraction: {
        source: 'none', page_count: 2, viewable_pages: [1, 2], native: true, tools: { tesseract: null }, pages: [], ms: 120,
        notes: ['2 of 2 page(s) are scanned images with no text layer and no OCR engine could be used. The bundled OCR engine is missing from /app/vendor/tesseract-wasm. Page 1, 2 are shown here at full scanner resolution.'],
        engine: { kind: 'none', version: null, path: null, tessdata: null, languages: [], language_requested: 'eng', psm: 4, reason: 'The bundled OCR engine is missing from /app/vendor/tesseract-wasm (expected tesseract-core-lstm.wasm.js and tesseract-core-lstm.wasm). Reinstall SOLIVY, or set SOLIVY_GRN_OCR_WASM_DIR to the folder that holds them.' },
        diagnostics: [
          { page: 1, status: 'not-attempted', engine: null, ms: 0, chars: 0, confidence: null, detail: 'The bundled OCR engine is missing.' },
          { page: 2, status: 'not-attempted', engine: null, ms: 0, chars: 0, confidence: null, detail: 'The bundled OCR engine is missing.' },
        ],
      },
      recognised: { grn: false, bill: false, grn_page: null, bill_page: null, unrecognised_pages: [] },
      link: { linked: false, confidence: 'low', reasons: [] },
      parsed: { grn: null, bill: null },
      draft: {
        purchase: { sample_no: '', purchase_date: '', truck_number: '', invoice_no: '', hsn: '', goods_description: '', bags_qty: 0, gross_weight: 0, net_weight: 0, rate: 0, freight: 0, unload_charge: 0, driver_rokdi: 0, other_charges: 0, moisture: 0, discount_pct: 0, quality_deduct_per_mt: 0, gst_type: 'NONE', gst_rate: 0, gst_taxable: 0, party_id: null },
        calculation: { gross_amount: 0, discount_amount: 0, quality_deduct_amount: 0, discount_base_amount: 0, total_deduction: 0, net_payable: 0, discount_after_quality: 1 },
        party: { matched: false, party_id: null, party_name: null, method: null, confidence: 'low', candidates: [], draft: null, bank_draft: null },
        broker: { name: null, party_id: null, matched: false },
        warnings: [{ code: 'REQUIRED_FIELDS', severity: 'blocking', message: 'The date, net weight, rate and vehicle number must be entered.' }],
        duplicates: [], evidence: {},
      },
    },
  },
};

function Harness() {
  const which = (location.hash.replace('#', '') || 'ok') as keyof typeof RESPONSES;
  const [open, setOpen] = useState(true);
  const [applied, setApplied] = useState<any>(null);
  const [form, setForm] = useState<Record<string, any>>({ truck_number: 'TYPED-BY-HAND', goods_description: 'Typed goods' });
  (window as any).__applied = applied;
  (window as any).__posts = (window as any).__posts || [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    (window as any).__posts.push(`${init.method || 'GET'} ${u}`);
    if (u.startsWith('/api/grn') && (init.method || 'GET') === 'POST') {
      const r = RESPONSES[which];
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('/api/grn')) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
    return originalFetch(url, init);
  }) as any;

  return (
    <div>
      <div id="form-state">{JSON.stringify(form)}</div>
      <div id="applied-state">{applied ? JSON.stringify(applied) : 'none'}</div>
      <button id="reopen" onClick={() => setOpen(true)}>Reopen</button>
      <GrnImportWizard open={open} companyId={1} mode="LIVE" current={form}
        onClose={() => setOpen(false)}
        onApply={(values, meta) => { setForm((f) => ({ ...f, ...values })); setApplied({ values, meta }); setOpen(false); }} />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
