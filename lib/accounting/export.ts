/** Report exports: CSV, XLSX and PDF (jsPDF, no extra dependencies). Amount columns are paise in, rupees out. */
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import type { Table, Col } from './registry';

const money = (p: any) => (p === null || p === undefined || p === '' ? '' : (Number(p) / 100).toFixed(2));
const moneyIN = (p: any) => (p === null || p === undefined || p === '' ? '' : new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(p) / 100));
function cell(c: Col, v: any, pretty = false) {
  if (v === null || v === undefined) return '';
  if (c.type === 'money') return pretty ? moneyIN(v) : money(v);
  if (c.type === 'pct') return v === '' ? '' : `${Number(v).toFixed(2)}%`;
  if (c.type === 'number') return typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
  return String(v).replace(/\s+/g, ' ').slice(0, 300);
}
function flatten(t: Table): Table[] { return t.sections?.length ? t.sections.map((s) => ({ ...s, title: s.title })) : [t]; }

export function toCSV(t: Table) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out: string[] = [esc(t.title) + (t.subtitle ? `,${esc(t.subtitle)}` : '')];
  for (const s of flatten(t)) {
    if (t.sections?.length) out.push('', esc(s.title));
    out.push(s.columns.map((c) => esc(c.label)).join(','));
    for (const r of s.rows) out.push(s.columns.map((c) => esc(cell(c, r[c.key]))).join(','));
    if (s.totals) out.push(s.columns.map((c) => esc(cell(c, s.totals[c.key]))).join(','));
  }
  for (const n of t.notes || []) out.push(esc(`Note: ${n}`));
  return '﻿' + out.join('\r\n');
}

export function toXLSX(t: Table): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const s of flatten(t)) {
    const aoa: any[][] = [[t.title], [t.subtitle || ''], [], s.columns.map((c) => c.label)];
    for (const r of [...s.rows, ...(s.totals ? [s.totals] : [])]) aoa.push(s.columns.map((c) => (c.type === 'money' ? (r[c.key] === null || r[c.key] === undefined || r[c.key] === '' ? '' : Number(r[c.key]) / 100) : r[c.key] ?? '')));
    for (const n of t.notes || []) aoa.push([`Note: ${n}`]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = s.columns.map((c) => ({ wch: Math.min(48, Math.max(10, c.label.length + 2)) }));
    let name = (s.title || 'Report').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Report'; let i = 2;
    while (used.has(name)) name = `${name.slice(0, 25)} ${i++}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

type PdfMeta = { organization: string; generatedAt: string; accent?: [number, number, number] };
function drawTable(doc: jsPDF, s: Table, y: number, meta: PdfMeta) {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12;
  const usable = W - 2 * M;
  const weights = s.columns.map((c) => (c.type === 'money' ? 1.2 : c.key.includes('narration') || c.key === 'details' || c.key === 'name' || c.key === 'party' || c.key === 'customer' || c.key === 'vendor' || c.key === 'message' ? 2.4 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * usable);
  const fs = s.columns.length > 9 ? 6.5 : 7.5;
  const header = () => {
    doc.setFillColor(...(meta.accent || [15, 118, 110])); doc.rect(M, y, usable, 6, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(fs);
    let x = M; s.columns.forEach((c, i) => { const txt = doc.splitTextToSize(c.label, widths[i] - 2)[0]; doc.text(txt, c.type === 'money' || c.type === 'number' || c.type === 'pct' ? x + widths[i] - 1 : x + 1, y + 4, { align: c.type === 'money' || c.type === 'number' || c.type === 'pct' ? 'right' : 'left' }); x += widths[i]; });
    doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'normal'); y += 6;
  };
  if (y > H - 30) { doc.addPage(); y = 20; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(s.title, M, y + 4); y += 7;
  header();
  const rows = [...s.rows, ...(s.totals ? [{ ...s.totals, __total: true }] : [])];
  rows.forEach((r, ri) => {
    const lines = s.columns.map((c, i) => doc.splitTextToSize(cell(c, r[c.key], true) || '', widths[i] - 2).slice(0, 3));
    const h = Math.max(1, ...lines.map((l) => l.length)) * (fs * 0.42) + 2;
    if (y + h > H - 14) { doc.addPage(); y = 20; header(); }
    if (r.__total) { doc.setFont('helvetica', 'bold'); doc.setDrawColor(120); doc.line(M, y, M + usable, y); }
    else if (ri % 2) { doc.setFillColor(245, 247, 248); doc.rect(M, y, usable, h, 'F'); }
    doc.setFontSize(fs);
    let x = M; s.columns.forEach((c, i) => { const right = c.type === 'money' || c.type === 'number' || c.type === 'pct'; doc.text(lines[i], right ? x + widths[i] - 1 : x + 1, y + fs * 0.42 + 0.5, { align: right ? 'right' : 'left' }); x += widths[i]; });
    if (r.__total) doc.setFont('helvetica', 'normal');
    y += h;
  });
  return y + 5;
}
function footer(doc: jsPDF, meta: PdfMeta, title: string) {
  const n = doc.getNumberOfPages(); const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(110); doc.text(`${meta.organization} · ${title} · generated ${meta.generatedAt} · SOLIVY Finance`, 12, H - 6); doc.text(`Page ${i} of ${n}`, W - 12, H - 6, { align: 'right' }); doc.setTextColor(30); }
}
function reportBody(doc: jsPDF, t: Table, meta: PdfMeta, startY = 14) {
  let y = startY;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(t.title, 12, y + 4);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`${meta.organization}${t.subtitle ? ' · ' + t.subtitle : ''}`, 12, y + 10); y += 16;
  for (const s of flatten(t)) y = drawTable(doc, t.sections?.length ? s : { ...s, title: '' }, y, meta);
  if (t.notes?.length) { doc.setFontSize(7.5); doc.setTextColor(90); for (const n of t.notes) { const lines = doc.splitTextToSize(`• ${n}`, doc.internal.pageSize.getWidth() - 24); if (y + lines.length * 3.5 > doc.internal.pageSize.getHeight() - 14) { doc.addPage(); y = 20; } doc.text(lines, 12, y); y += lines.length * 3.5 + 1; } doc.setTextColor(30); }
}

export function toPDF(t: Table, meta: PdfMeta): Buffer {
  const wide = flatten(t).some((s) => s.columns.length > 6);
  const doc = new jsPDF({ orientation: wide ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  reportBody(doc, t, meta);
  footer(doc, meta, t.title);
  return Buffer.from(doc.output('arraybuffer'));
}

export function packagePDF(title: string, period: string, tables: Table[], meta: PdfMeta): Buffer {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  doc.setFillColor(...(meta.accent || [15, 118, 110])); doc.rect(0, 0, W, 70, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.text(title, 20, 38);
  doc.setFontSize(13); doc.setFont('helvetica', 'normal'); doc.text(meta.organization, 20, 50); doc.text(period, 20, 58);
  doc.setTextColor(60); doc.setFontSize(9); doc.text(`Prepared ${meta.generatedAt} with SOLIVY Finance. Derived double-entry statements — accounts marked “review” require confirmation by a Chartered Accountant before statutory use.`, 20, H - 20, { maxWidth: W - 40 });
  doc.addPage();
  const tocPage = doc.getNumberOfPages();
  const starts: number[] = [];
  for (const t of tables) { doc.addPage(); starts.push(doc.getNumberOfPages()); reportBody(doc, t, meta); }
  doc.setPage(tocPage); doc.setTextColor(30); doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text('Contents', 20, 25);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  tables.forEach((t, i) => { const y = 38 + i * 9; doc.text(`${i + 1}. ${t.title}`, 24, y); doc.text(String(starts[i]), W - 24, y, { align: 'right' }); doc.setDrawColor(200); doc.line(24, y + 2, W - 24, y + 2); });
  footer(doc, meta, title);
  return Buffer.from(doc.output('arraybuffer'));
}
