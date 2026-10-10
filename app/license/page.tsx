"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
function LicenseNotice() {
  const params = useSearchParams();
  const reason = params.get("reason") || "A valid SOLIVY Finance license is required.";
  return <main className="min-h-screen grid place-items-center bg-slate-950 p-5"><section className="w-full max-w-lg rounded-3xl border border-white/10 bg-white p-8 shadow-2xl"><div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-orange-500 font-black text-white">S</div><p className="text-xs font-black uppercase tracking-[.18em] text-orange-600">SOLIVY Finance</p><h1 className="mt-2 text-2xl font-black text-slate-900">License attention required</h1><p className="mt-3 text-sm leading-6 text-slate-600">{reason}</p><p className="mt-3 text-sm leading-6 text-slate-600">Your stored financial data has not been deleted. An administrator can sign in and open License Management to review the organization, expiry date and included modules.</p><a href="/login" className="mt-6 inline-flex rounded-xl bg-orange-600 px-5 py-3 font-bold text-white">Return to sign in</a></section></main>;
}
export default function LicensePage() { return <Suspense fallback={<main className="min-h-screen grid place-items-center bg-slate-950 p-5 text-white">Loading license details…</main>}><LicenseNotice /></Suspense>; }
