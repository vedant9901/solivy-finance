'use client';

/**
 * The one place appearance is applied (v2.8.0). Both the root-level AppearanceSync and the theme
 * control call this, so a change takes effect immediately and identically wherever it is made.
 * Preferences live in localStorage, so they persist per device and survive sign-out.
 */
export const ACCENTS: Record<string, [string, string]> = {
  teal: ['#0f766e', '#115e59'], blue: ['#2563eb', '#1d4ed8'], violet: ['#7c3aed', '#6d28d9'],
  emerald: ['#059669', '#047857'], amber: ['#b45309', '#92400e'], rose: ['#e11d48', '#be123c'],
  slate: ['#334155', '#1e293b'],
};
export type Mode = 'light' | 'dark' | 'system';

export const readPref = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };

export function applyAppearance() {
  if (typeof document === 'undefined') return;
  const accentName = readPref('solivy-theme', 'teal');
  const mode = readPref('solivy-mode', 'light');
  const lang = readPref('solivy-language', 'en');
  const prefersDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : (mode === 'dark' ? 'dark' : 'light');
  const root = document.documentElement;
  root.dataset.mode = resolved;
  root.dataset.accent = ACCENTS[accentName] ? accentName : 'teal';
  root.dataset.solivyTheme = accentName;                 // kept for styles written before v2.8.0
  root.lang = ['hi', 'gu'].includes(lang) ? lang : 'en';
  const [primary, hover] = ACCENTS[accentName] || ACCENTS.teal;
  root.style.setProperty('--primary', primary);
  root.style.setProperty('--primary-hover', hover);
}

export function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode: applies for this session only */ }
  applyAppearance();
  window.dispatchEvent(new CustomEvent('solivy-appearance-updated'));
}
