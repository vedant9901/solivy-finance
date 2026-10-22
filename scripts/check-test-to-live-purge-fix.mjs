import fs from 'node:fs';
const route = fs.readFileSync('app/api/test-to-live/route.ts', 'utf8');
const db = fs.readFileSync('lib/db.ts', 'utf8');
const checks = [
  ['promotion excludes only preserved company_settings from empty-LIVE guard', /protectedTables\s*=\s*tables\.filter\(table\s*=>\s*table\s*!==\s*'company_settings'\)/.test(route)],
  ['promotion still blocks when protected LIVE tables contain rows', /populatedTables\s*=\s*protectedTables\.filter\(table\s*=>\s*count\(table\)\s*>\s*0\)/.test(route) && /if\(populatedTables\.length\)throw Error/.test(route)],
  ['promotion reports which LIVE tables block it', /populatedTables\.join\(', '\)/.test(route)],
  ['company settings are replaced from TEST during promotion', /table==='company_settings'\?'INSERT OR REPLACE':'INSERT'/.test(route)],
  ['purge still clears financial and master tables', /export function resetMode\(mode:Mode,companyId=1\)/.test(db) && /'parties','third_parties','import_batches','audit_logs'/.test(db)],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log(`TEST-TO-LIVE PURGE FIX CHECKS PASSED: ${checks.length}/${checks.length}`);
