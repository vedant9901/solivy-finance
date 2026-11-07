import fs from 'node:fs';
const api=fs.readFileSync('app/api/transfers/route.ts','utf8');
const ui=fs.readFileSync('app/page.tsx','utf8');
const map=fs.readFileSync('lib/transfers/mapping.ts','utf8');
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
 // v2.12.3: an unmatched party/account is a choice the receiver makes, never one the code makes.
 ['link resolution lives in one module, not duplicated per call site',map.includes('export function resolve')&&!/SELECT id FROM company_accounts WHERE LOWER\(TRIM\(account_name\)\)/.test(api)&&!/SELECT id FROM parties WHERE LOWER\(TRIM\(name\)\)/.test(api)],
 ['an explicit map is verified against the destination before use',/function verify\(/.test(map)&&/SELECT id FROM company_accounts WHERE id=\?/.test(map)],
 ['a near match is only ever a suggestion, never applied',/suggestion: Candidate \| null/.test(map)&&/hits\.length === 1 \? hits\[0\] : null/.test(map)&&!/return suggestion\(/.test(map.replace(/suggestion: suggestion\([^)]*\)/g,''))],
 ['an unresolved link refuses the import outright',/MAPPING_REQUIRED/.test(api)&&/if\(id===null\)throw Error\(missingFor/.test(api)],
 ['acceptance is preflighted before any write',/const pre=preflight\(d,p,spec\.links,spec\.ref,maps\)/.test(api)],
 ['a read-only preflight action is available to the receiver',/action==='preflight'/.test(api)],
 ['the sender is told at send time what the destination cannot match',/unresolved_links:unresolved\.length/.test(api)],
 ['mapped choices are recorded in the audit log and the receipt',/appliedMap:appliedMap\(maps\)/.test(api)&&(api.match(/appliedMap\(maps\)/g)||[]).length>=2],
 ['the ledger bundle keeps matching parties by name alone',/identity\?: 'full' \| 'name'/.test(map)&&/identity === 'name'/.test(map)&&/identity:'name' as const/.test(api)],
 ['map entries are bounded and must be positive integers',/function sanitiseMaps/.test(api)&&/slice\(0,500\)/.test(api)&&/Number\.isSafeInteger\(id\)&&id>0/.test(api)],
 ['UI lets the receiver choose the matching record',/MAPPING_REQUIRED/.test(ui)&&/Accept with these choices/.test(ui)&&/Destination \$\{u\.kind\} for \$\{u\.name\}/.test(ui)],
 ['UI requires every link to be chosen before accepting',/\.some\(\(u:any\)=>!Number\(choice\[`\$\{u\.kind\}:\$\{u\.name\}`\]\|\|0\)\)/.test(ui)],
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;}
console.log(`Transfer source checks: ${checks.length-failed}/${checks.length} passed`);if(failed)process.exitCode=1;
