const fs = require('fs');
const s = fs.readFileSync('app/page.tsx', 'utf8');
const api = fs.readFileSync('app/api/data/route.ts','utf8');
const checks = [
  ['turnover uses posted financing receivable bills', /const receivables=\(data\.receivables\|\|\[\]\)\.filter\(\(r:any\)=>String\(r\.purchase_status\|\|'POSTED'\)/],
  ['receivables include source purchase status', /pu\.status purchase_status FROM financing_receivables/],
  ['FY comparison uses receivable bill date', /dateIn\(r\.bill_date,fyStart,fyEnd\)/],
  ['month-on-month uses receivable turnover', /billValue\(thisBills\.filter/],
  ['top parties rank by receivable billing value', /Top parties · \{fyLabel\}/],
  ['average billing value shown', /Average billing value/],
  ['realised margin is separate', /Realised profit margin/],
  ['book margin is separate', /Book profit margin/],
  ['funding is loans plus cumulative net profit', /activeLoanPrincipal\+netProfitToDate/],
  ['sales shown separately', /Sales invoices · \{fyLabel\}/],
  ['supplier payments shown separately', /Supplier payments · \{fyLabel\}/],
  ['money-in shown separately', /Money received · \{fyLabel\}/],
  ['withdrawals shown separately', /Withdrawals · \{fyLabel\}/],
];
let failed=0;
for (const [name,re] of checks) { const ok=re.test(name.includes('receivables include')?api:s); console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) failed++; }
console.log(`Dashboard metric source checks: ${checks.length-failed}/${checks.length} passed`);
process.exit(failed?1:0);
