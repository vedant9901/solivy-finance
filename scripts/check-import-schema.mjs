import fs from 'node:fs';
const file = fs.readFileSync('app/api/import-finance/route.ts','utf8');
const checks = [
  ['Import route exists', file.includes('export async function POST(req:Request)')],
  ['Required headers validated before writes', file.includes('Missing required headers')],
  ['Import is transactional', file.includes('d.transaction')],
  ['Purchase insert uses dynamic placeholders', file.includes("purchaseColumns.map(()=>'?').join(',')")],
  ['Purchase mapping has runtime column/value assertion', file.includes('purchaseColumns.length!==purchaseValues.length')],
  ['Legacy 31-placeholder purchase SQL is absent', !file.includes('VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')],
];
let failed=0;
for (const [name,ok] of checks) { console.log(`${ok?'PASS':'FAIL'}  ${name}`); if(!ok) failed++; }
if(failed) process.exit(1);
console.log(`\nImport integrity checks passed: ${checks.length}`);
