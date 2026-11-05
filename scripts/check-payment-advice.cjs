#!/usr/bin/env node
/**
 * v2.12.1 — the payment advice presents moisture and the quality deduction by the one authoritative
 * rule, and invents no threshold formula.
 */
const fs = require('node:fs');
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

const route = fs.readFileSync('app/api/payment-advice/route.ts', 'utf8');
const model = fs.readFileSync('lib/documents/advice-model.ts', 'utf8');
const bill = fs.readFileSync('lib/documents/bill-model.ts', 'utf8');
const calc = fs.readFileSync('lib/utils.ts', 'utf8');
const settings = fs.readFileSync('app/api/document-settings/route.ts', 'utf8');

check('the advice no longer builds its own deduction list; it uses the shared model',
  /adviceDeductions\(r,s\)/.test(route) && !/\['Unload Charges',r\.unload_charge/.test(route));
check('the query selects the quality rule, so a recorded percentage is never printed as rupees',
  /q\.quality_deduct_rate_per_kg/.test(route) && /q\.quality_deduct_per_mt/.test(route) && /q\.total_deduction/.test(route));
check('under the rate-per-kg rule the quality deduction appears once, not as moisture and quality both',
  /One row, never both/.test(model) && /m\.perKgRule/.test(model));
check('the advice and the bills apply the same rule', /perKgRule/.test(model) && /perKgRule/.test(bill));
check('the advice keeps the layout it had: the percentage rides in the deduction row label',
  /layout is unchanged/.test(model) && !/moistureFacts|moistureNotes/.test(route)
  && /Moisture Deduction/.test(fs.readFileSync('lib/documents/moisture.ts', 'utf8')));
check('no threshold is applied, and none appears as a figure in this path',
  /no threshold and no per-excess-percentage rate/.test(model)
  && !/14(\.00)?\b/.test(model.replace(/^\s*\*.*$/gm, '')) && !/threshold/i.test(route));
check('no moisture threshold or per-excess rate exists in the authoritative calculation',
  !/threshold/i.test(calc) && !/excess/i.test(calc));
check('no deduction is derived from a threshold anywhere in the advice path',
  !/excess/i.test(route) && !/threshold\s*\*/.test(route) && !/\*\s*threshold/.test(route));
check('the row order the advice has always printed is preserved',
  /unload, freight, moisture, discount, rokdi, quality, other/.test(model));
check('the rows are compared with the stored total, and nothing is adjusted to make them agree',
  /reconciles/.test(model) && /storedTotal/.test(model) && !/total_deduction\s*=/.test(model));
check('a row the user switched off is not reported as a mismatch', /hiddenRows/.test(model) && /allEnabled/.test(model));
check('the advice remains read-only: no write of any kind in the route',
  !/\b(INSERT|UPDATE|DELETE)\b/i.test(route));
check('no new payment-advice setting was introduced for this fix',
  !/show_moisture_percent|show_quality_basis/.test(settings));

if (failed) { console.error(`${failed} payment-advice check(s) failed`); process.exit(1); }
console.log('Payment advice checks passed');
