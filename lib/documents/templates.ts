/**
 * Bill templates (v2.7.0). 'classic' is the v2.6.30 layout (rendered by the purchase-bill route);
 * the others render the same BillModel, so every template prints identical figures.
 */
import { jsPDF } from 'jspdf';
import type { BillModel } from './bill-model';

export type Theme = { accent?: string; font?: 'helvetica' | 'times' | 'courier'; density?: 'normal' | 'compact' };
export const TEMPLATES = [
  { id: 'classic', name: 'Classic', description: 'The existing one-page commercial invoice layout (v2.6.30).' },
  { id: 'modern', name: 'Modern', description: 'Accent header band, card-style party and bill details.' },
  { id: 'boxed', name: 'Boxed GST grid', description: 'Fully ruled grid in the familiar tax-invoice style.' },
  { id: 'compact', name: 'Compact', description: 'Dense half-page layout for quick dispatch copies.' },
  { id: 'minimal', name: 'Minimal letterhead', description: 'Clean letterhead with thin rules and generous spacing.' },
] as const;
export type TemplateId = typeof TEMPLATES[number]['id'];
export const isTemplate = (v: any): v is TemplateId => TEMPLATES.some((t) => t.id === v);

const inr = (v: number) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function rgb(hex?: string): [number, number, number] {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [15, 118, 110];
  const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
type Style = { id: TemplateId; band: boolean; grid: boolean; boxes: boolean; scale: number; maxY: number; rule: boolean };
const STYLES: Record<Exclude<TemplateId, 'classic'>, Style> = {
  modern: { id: 'modern', band: true, grid: false, boxes: true, scale: 1, maxY: 287, rule: false },
  boxed: { id: 'boxed', band: false, grid: true, boxes: true, scale: 1, maxY: 287, rule: false },
  compact: { id: 'compact', band: false, grid: false, boxes: false, scale: 0.86, maxY: 148, rule: true },
  minimal: { id: 'minimal', band: false, grid: false, boxes: false, scale: 1, maxY: 287, rule: true },
};

export function renderBillTemplate(m: BillModel, template: Exclude<TemplateId, 'classic'>, theme: Theme = {}): Buffer {
  const st = STYLES[template];
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const font = theme.font || (template === 'minimal' ? 'times' : 'helvetica');
  const acc = rgb(theme.accent);
  const k = st.scale * (theme.density === 'compact' ? 0.92 : 1);
  const fs = (n: number) => doc.setFontSize(n * k);
  const L = 12, R = 198, W = R - L;
  let y = 12;
  const txt = (s: string, x: number, yy: number, opts: any = {}) => { if (s) doc.text(opts.maxWidth ? doc.splitTextToSize(s, opts.maxWidth) : s, x, yy, opts.align ? { align: opts.align } : undefined); };
  doc.setTextColor(25, 25, 25); doc.setDrawColor(60, 60, 60); doc.setLineWidth(0.25);

  // ---- header ----
  if (st.band) {
    doc.setFillColor(...acc); doc.rect(0, 0, 210, 30 * k, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont(font, 'bold'); fs(16); txt(m.company.name, L, 12 * k);
    doc.setFont(font, 'normal'); fs(7.5); m.company.lines.slice(0, 3).forEach((l, i) => txt(l, L, (17 + i * 3.6) * k, { maxWidth: 120 }));
    doc.setFont(font, 'bold'); fs(18); txt(m.title, R, 14 * k, { align: 'right' });
    if (m.show.headerDate) { fs(8); doc.setFont(font, 'normal'); txt(`Date: ${m.show.headerDate}`, R, 21 * k, { align: 'right' }); }
    doc.setTextColor(25, 25, 25); y = 36 * k;
  } else {
    doc.setFont(font, 'bold'); fs(template === 'minimal' ? 18 : 14); txt(m.company.name, L, y + 4);
    doc.setFont(font, 'normal'); fs(7.6); let cy = y + 9; for (const l of m.company.lines) { txt(l, L, cy, { maxWidth: 120 }); cy += 3.6 * k; }
    doc.setFont(font, 'bold'); fs(template === 'boxed' ? 13 : 15); doc.setTextColor(...acc); txt(m.title, R, y + 4, { align: 'right' }); doc.setTextColor(25, 25, 25);
    if (m.show.headerDate) { doc.setFont(font, 'normal'); fs(8); txt(`Date: ${m.show.headerDate}`, R, y + 9, { align: 'right' }); }
    y = Math.max(cy, y + 14) + 2;
    if (st.rule) { doc.setDrawColor(...acc); doc.setLineWidth(0.6); doc.line(L, y, R, y); doc.setLineWidth(0.25); doc.setDrawColor(60, 60, 60); y += 4; }
  }

  // ---- buyer + bill details ----
  const half = L + W * 0.58;
  const metaH = Math.max(m.meta.length * 5.2 * k + 7, (m.buyer.lines.length + m.broker.length) * 3.8 * k + 14);
  if (st.boxes) { doc.rect(L, y, half - L - 2, metaH); doc.rect(half, y, R - half, metaH); }
  doc.setFont(font, 'bold'); fs(7); doc.setTextColor(...acc); txt('BILL TO', L + 3, y + 5); txt('BILL DETAILS', half + 3, y + 5); doc.setTextColor(25, 25, 25);
  fs(9.5); txt(m.buyer.name, L + 3, y + 10.5, { maxWidth: half - L - 8 });
  doc.setFont(font, 'normal'); fs(7.6);
  let by = y + 15; for (const l of [...m.buyer.lines, ...m.broker]) { txt(l, L + 3, by, { maxWidth: half - L - 8 }); by += 3.8 * k; }
  let my = y + 10.5;
  for (const [label, value] of m.meta) {
    doc.setFont(font, 'bold'); fs(7.4); txt(label, half + 3, my);
    doc.setFont(font, 'normal'); txt(value, R - 3, my, { align: 'right' });
    if (st.grid) { doc.setDrawColor(200, 200, 200); doc.line(half, my + 1.6, R, my + 1.6); doc.setDrawColor(60, 60, 60); }
    my += 5.2 * k;
  }
  y += metaH + 4;

  // ---- goods table ----
  const cols = m.columns; const tw = cols.reduce((a, c) => a + c.weight, 0);
  const ws = cols.map((c) => (W * c.weight) / tw); const xs = [L]; for (const w of ws) xs.push(xs[xs.length - 1] + w);
  const head = 8 * k;
  if (st.band || st.id === 'boxed') { doc.setFillColor(...acc); doc.rect(L, y, W, head, 'F'); doc.setTextColor(255, 255, 255); }
  else { doc.setDrawColor(...acc); doc.setLineWidth(0.5); doc.line(L, y + head, R, y + head); doc.setLineWidth(0.25); doc.setDrawColor(60, 60, 60); }
  doc.setFont(font, 'bold'); fs(7);
  cols.forEach((c, i) => txt(c.label, c.align === 'right' || c.key === 'rate' ? xs[i + 1] - 2 : xs[i] + 2, y + 5.2 * k, { align: c.align === 'right' || c.key === 'rate' ? 'right' : undefined }));
  doc.setTextColor(25, 25, 25);
  const tableTop = y; y += head + 6 * k;
  doc.setFont(font, 'normal'); fs(8);
  cols.forEach((c, i) => {
    if (c.key === 'description') { doc.setFont(font, 'bold'); txt(c.value, xs[i] + 2, y, { maxWidth: ws[i] - 4 }); doc.setFont(font, 'normal'); if (m.bags) { fs(7.4); txt(m.bags, xs[i] + 2, y + 4.5 * k); fs(8); } }
    else txt(c.value, c.align === 'right' || c.key === 'rate' ? xs[i + 1] - 2 : xs[i] + 2, y, { align: c.align === 'right' || c.key === 'rate' ? 'right' : undefined });
  });
  y += 11 * k;
  const descI = cols.findIndex((c) => c.key === 'description'); const amtI = cols.findIndex((c) => c.key === 'amount');
  const lx = descI >= 0 ? xs[descI] + 2 : L + 2; const rx = amtI >= 0 ? xs[amtI + 1] - 2 : R - 2;
  for (const dd of m.deductions) {
    fs(7.5); doc.setFont(font, 'normal'); txt('Less :', lx, y); doc.setFont(font, 'bold'); txt(dd.label, lx + 14, y);
    doc.setFont(font, 'normal'); txt(`(-) ${Math.round(dd.amount).toLocaleString('en-IN')}`, rx, y, { align: 'right' });
    y += 4.8 * k;
  }
  y += 2;
  // The goods table always grows with its content (never capped), so no row can overlap the total.
  const tableBottom = Math.max(y + 2, tableTop + 45 * k);
  if (st.grid) { doc.rect(L, tableTop, W, tableBottom + 9 * k - tableTop); for (let i = 1; i < xs.length - 1; i++) doc.line(xs[i], tableTop, xs[i], tableBottom); }
  else if (st.boxes) doc.rect(L, tableTop, W, tableBottom + 9 * k - tableTop);
  // total row
  doc.setDrawColor(...acc); doc.setLineWidth(0.5); doc.line(L, tableBottom, R, tableBottom); doc.setLineWidth(0.25); doc.setDrawColor(60, 60, 60);
  doc.setFont(font, 'bold'); fs(8.5); txt('Total', L + 2, tableBottom + 6 * k);
  const qI = cols.findIndex((c) => c.key === 'quantity' || c.key === 'net'); if (qI >= 0 && m.quantityText) txt(m.quantityText, xs[qI + 1] - 2, tableBottom + 6 * k, { align: 'right' });
  txt(`₹ ${inr(m.total)}`.replace('₹', 'Rs.'), R - 2, tableBottom + 6 * k, { align: 'right' });
  y = tableBottom + 15 * k;

  // ---- words, bank, declaration, signature ----
  if (m.show.amountWords) { doc.setFont(font, 'bold'); fs(7.3); txt('Amount Chargeable (in words)', L, y); doc.setFont(font, 'normal'); fs(8.2); txt(m.amountWords, L, y + 5, { maxWidth: 110 }); }
  fs(7); doc.setFont(font, 'bold'); txt('E. & O.E', R, y, { align: 'right' });
  y += 14 * k;
  const blockTop = y;
  if (m.show.declaration) { doc.setFont(font, 'bold'); fs(7.5); txt('Declaration', L, y); doc.setFont(font, 'normal'); fs(7.2); txt('We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.', L, y + 5, { maxWidth: 88 }); }
  if (m.show.bank) { doc.setFont(font, 'bold'); fs(7.5); txt("Company's Bank Details", 110, blockTop); doc.setFont(font, 'normal'); fs(7.2); let b = blockTop + 5; for (const l of m.companyBank) { txt(l, 110, b, { maxWidth: 86 }); b += 4 * k; } }
  let endY = blockTop + (m.show.bank ? 5 + m.companyBank.length * 4 * k : 0) + (m.show.declaration ? 12 : 0);
  if (m.show.signature) { const sy = blockTop + 24 * k; endY = sy + 12; doc.setFont(font, 'bold'); fs(7.5); txt(`for ${m.company.name}`, R, sy, { align: 'right' }); doc.line(150, sy + 7, R, sy + 7); doc.setFont(font, 'normal'); txt('Authorised Signatory', R, sy + 11, { align: 'right' }); }
  const footerY = template === 'compact' ? Math.min(Math.max(endY + 6, st.maxY - 4), 290) : 287;
  doc.setFont(font, 'normal'); fs(6.8); doc.setTextColor(110, 110, 110);
  txt('This is a Computer Generated Invoice', 105, footerY, { align: 'center' });
  if (template === 'compact' && footerY + 4 < 292) { doc.setLineDashPattern([1.5, 1.5], 0); doc.line(L, footerY + 4, R, footerY + 4); doc.setLineDashPattern([], 0); }
  return Buffer.from(doc.output('arraybuffer'));
}
