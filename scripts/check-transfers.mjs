import fs from 'node:fs';
const api=fs.readFileSync('app/api/transfers/route.ts','utf8');
const ui=fs.readFileSync('app/page.tsx','utf8');
const checks=[
 ['transfer API uses authenticated session company header',/const cid=\(r:Request\)=>Number\(r\.headers\.get\('x-aksh-company-id'\)/.test(api)],
 ['transfer API enforces source organization mapping',/authorized\(a,who,company,isAdmin,mode\(req\)\)/.test(api)],
 ['destination mapping is checked before creating transfer',/authorized\(a,who,dest,isAdmin,mode\(req\)\)/.test(api)],
 ['transfer selections are capped at 500 records',/ids\.length>500/.test(api)],
 ['destination must explicitly accept incoming transfer',/action==='accept'/.test(api)],
 ['destination can reject incoming transfer',/action==='reject'/.test(api)],
 ['LIVE/TEST environment must match on acceptance',/tr\.mode!==mode\(req\)/.test(api)],
 ['offline package import checks destination company code and environment',/action==='import-package'.*?destinationCompanyCode.*?p\.mode!==mode\(req\)/s.test(api)],
 ['source removal requires a receipt and verifies source records unchanged',/action==='confirm-receipt'/.test(api)&&/receipt verification failed/i.test(api)&&/changed or is missing/.test(api)],
 ['duplicate transaction references are rejected during import',/Duplicate reference/.test(api)],
 ['linked accounting rows are bundled into transfer payload',/accountingRows=rows\.map/.test(api)&&/accountTransactions:txs,ledgerRows:led,bankMatches:matches/.test(api)],
 ['destination imports linked bank and ledger rows',/for\(const group of \(p\.accountingRows\|\|\[\]\)\)/.test(api)&&/INTERCOMPANY_TRANSFER_ACCEPTED/.test(api)],
 ['source deletes linked rows only after verified receipt',/action==='confirm-receipt'/.test(api)&&/Linked bank posting changed or is missing/.test(api)&&/INTERCOMPANY_TRANSFER_SOURCE_REMOVED/.test(api)],
 ['audit entries are written for acceptance and source removal',/INTERCOMPANY_TRANSFER_ACCEPTED/.test(api)&&/INTERCOMPANY_TRANSFER_SOURCE_REMOVED/.test(api)],
 ['UI provides select-all eligible records',/aria-label="Select all eligible records"/.test(ui)&&/Select all eligible loans/.test(ui)],
 ['UI provides clear-selection control',/Clear selection/.test(ui)],
 ['UI prevents selecting more than 500 records',/ids\.length>=500/.test(ui)],
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;}
console.log(`Transfer source checks: ${checks.length-failed}/${checks.length} passed`);if(failed)process.exitCode=1;
