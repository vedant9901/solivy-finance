'use client';
import { useEffect, useRef, useState } from 'react';
import { FiSun, FiMoon, FiMonitor } from 'react-icons/fi';

/** Shared v2.8.0 interface pieces: theme control, loading skeletons, animated figures. */

import { ACCENTS as ACCENT_MAP, applyAppearance, readPref, savePref } from '../lib/appearance';
const ACCENTS = Object.entries(ACCENT_MAP).map(([name, pair]) => [name, pair[0]] as [string, string]);
const read = readPref;
const write = savePref;

/** Light / dark / system plus the accent palette. Both choices persist across sessions. */
export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState('light');
  const [accent, setAccent] = useState('teal');
  useEffect(() => { setMode(read('solivy-mode', 'light')); setAccent(read('solivy-theme', 'teal')); applyAppearance(); }, []);
  const pick = (next: string) => { setMode(next); write('solivy-mode', next); };
  const pickAccent = (next: string) => { setAccent(next); write('solivy-theme', next); };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="theme-switch" role="group" aria-label="Appearance">
        {([['light', FiSun, 'Light'], ['dark', FiMoon, 'Dark'], ['system', FiMonitor, 'System']] as const).map(([key, Icon, label]) => (
          <button key={key} type="button" aria-pressed={mode === key} aria-label={label} title={label} onClick={() => pick(key)}>
            <Icon size={14} aria-hidden="true" />{!compact && <span>{label}</span>}
          </button>
        ))}
      </div>
      <div className="accent-dots" role="group" aria-label="Colour theme">
        {ACCENTS.map(([key, colour]) => (
          <button key={key} type="button" className="accent-dot" style={{ background: colour }} aria-pressed={accent === key} aria-label={`${key} theme`} title={key} onClick={() => pickAccent(key)} />
        ))}
      </div>
    </div>
  );
}

export function Skeleton({ className = '', lines = 0 }: { className?: string; lines?: number }) {
  if (lines > 0) return <div aria-hidden="true">{Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton skeleton-text" style={{ width: `${90 - i * 12}%` }} />)}</div>;
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading figures">{Array.from({ length: count }).map((_, i) => <div key={i} className="card p-4"><Skeleton className="skeleton-text" /><Skeleton className="skeleton-kpi" /></div>)}</div>;
}

export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return <div className="card p-4" aria-busy="true" aria-label="Loading records">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="skeleton-row" />)}</div>;
}

/**
 * Counts to a new value instead of jumping. Respects reduced-motion and shows the exact figure at
 * the end, so a financial amount is never left mid-animation.
 */
export function Counter({ value, format, duration = 650, className = '' }: { value: number; format?: (n: number) => string; duration?: number; className?: string }) {
  const fmt = format || ((n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n)));
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const target = Number(value) || 0;
    const start = Number(from.current) || 0;
    from.current = target;
    if (start === target) { setShown(target); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(target); return; }
    let raf = 0; const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(start + (target - start) * eased);
      if (p < 1) raf = requestAnimationFrame(step); else setShown(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={`counter ${className}`}>{fmt(shown)}</span>;
}
