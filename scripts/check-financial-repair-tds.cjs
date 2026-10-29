const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'app/api/admin/route.ts'), 'utf8');
const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
const recv = fs.readFileSync(path.join(root, 'app/api/receivables/route.ts'), 'utf8');
const reverse = fs.readFileSync(path.join(root, 'app/api/reverse/route.ts'), 'utf8');
const db = fs.readFileSync(path.join(root, 'lib/db.ts'), 'utf8');
const checks = [
  ['Admin-only financial repair API', admin.includes("role!=='ADMIN'") && admin.includes('financial_repair_adjust')],
  ['Verified closing balance confirmation phrase', admin.includes('REPAIR BALANCE ${mode}')],
  ['Balance correction blocked when suspicious receipt/reversal entries exist', admin.includes('Balance correction is blocked:') && admin.includes('if(suspicious.length>0)')],
  ['Correction gate runs before account mutation and backup', admin.indexOf('if(suspicious.length>0)') < admin.indexOf('const backupFile=makeBackup(mode,companyId)', admin.indexOf("if(x.action==='financial_repair_adjust')"))],
  ['UI explains suspicious-entry restriction', page.includes('only when diagnostics find no suspicious finance receipt/reversal entries')],
  ['Pre-repair database backup', admin.includes('makeBackup(mode,companyId)')],
  ['Audit log records adjustment context', admin.includes('ADMIN_BANK_BALANCE_REPAIR') && admin.includes('targetBalance:target')],
  ['TDS credits tracked separately from bank cash', db.includes('CREATE TABLE IF NOT EXISTS tds_credit_entries') && recv.includes('INSERT INTO tds_credit_entries')],
  ['TDS described as receivable/advance-tax asset, not expense', recv.includes('TDS receivable/advance tax, not expense') && page.includes('not an operating expense')],
  ['Finance receipt reversal preserves TDS history', reverse.includes("UPDATE tds_credit_entries SET status='REVERSED'")],
  ['Financial repair diagnostics expose TDS totals', admin.includes('tdsCreditSummary') && page.includes('repairData.tdsCreditSummary')],
  ['TDS amounts use paise precision', recv.includes('Math.round((n(v)+Number.EPSILON)*100)/100')],
];
let failed = false;
for (const [label, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`); if (!pass) failed = true; }
if (failed) process.exit(1);
console.log('Financial repair and TDS source regression checks passed.');
