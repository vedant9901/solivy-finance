'use client';
import { useEffect } from 'react';
import { applyAppearance } from '../lib/appearance';

/** Applies the saved appearance on load and keeps it in step across tabs and with the OS setting. */
export default function AppearanceSync() {
  useEffect(() => {
    applyAppearance();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener('storage', applyAppearance);
    window.addEventListener('solivy-appearance-updated', applyAppearance);
    media.addEventListener('change', applyAppearance);
    return () => {
      window.removeEventListener('storage', applyAppearance);
      window.removeEventListener('solivy-appearance-updated', applyAppearance);
      media.removeEventListener('change', applyAppearance);
    };
  }, []);
  return null;
}
