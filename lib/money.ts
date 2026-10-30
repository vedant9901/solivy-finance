/**
 * Money helpers for new accounting code (journal, reports, templates).
 * Amounts are carried as integer paise so sums are exact; conversion uses half-away-from-zero
 * rounding at 2 decimals. Existing route formulas are NOT changed by this module (they keep
 * their documented rupee rounding, covered by tests/unit/calculations.test.ts).
 */
export type Paise = number;

export function toPaise(rupees: unknown): Paise {
  const n = Number(rupees ?? 0);
  if (!Number.isFinite(n)) return 0;
  const scaled = Math.abs(n) * 100;
  // Correct binary artefacts such as 1.005 * 100 = 100.49999999999999.
  const rounded = Math.round(scaled + 1e-7);
  return n < 0 ? -rounded : rounded;
}
export function toRupees(p: Paise): number { return Math.round(p) / 100; }
export function sumPaise(values: Iterable<unknown>): Paise { let s = 0; for (const v of values) s += toPaise(v); return s; }
export function formatINR(p: Paise, opts: { symbol?: boolean } = {}) {
  const v = toRupees(p);
  const s = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  return `${v < 0 ? '-' : ''}${opts.symbol === false ? '' : '₹'}${s}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n: number) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`; }
function threeDigits(n: number) { const h = Math.floor(n / 100), r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' '); }

/** Indian numbering words for a whole number (Crore/Lakh/Thousand/Hundred), recursive above 99 crore. */
function indianWords(n: number): string {
  if (n === 0) return '';
  const crore = Math.floor(n / 10_000_000); n %= 10_000_000;
  const lakh = Math.floor(n / 100_000); n %= 100_000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  return [crore ? `${indianWords(crore)} Crore` : '', lakh ? `${twoDigits(lakh)} Lakh` : '', thousand ? `${twoDigits(thousand)} Thousand` : '', n ? threeDigits(n) : ''].filter(Boolean).join(' ');
}

/** "Rupees … and … Paise Only" (Indian numbering). */
export function amountInWordsINR(p: Paise): string {
  const neg = p < 0; const abs = Math.abs(Math.round(p));
  const rupees = Math.floor(abs / 100); const paise = abs % 100;
  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';
  const words = indianWords(rupees);
  return `${neg ? 'Minus ' : ''}Rupees ${words || 'Zero'}${paise ? ` and ${twoDigits(paise)} Paise` : ''} Only`;
}

/** Indian financial year (April–March) containing the date: { start, end, label: '2026-27' }. */
export function financialYear(date: string) {
  const [y, m] = date.slice(0, 10).split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}` };
}
