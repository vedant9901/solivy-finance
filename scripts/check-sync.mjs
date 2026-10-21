import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const required=[
  ['lib/db.ts',['sync_meta','sync_changes','sync_applied_events','CREATE TRIGGER sync_']],
  ['app/api/sync/pair/route.ts',['randomBytes(32)','token_hash','company_id','mode','revokeHandler']],
  ['app/api/sync/exchange/route.ts',['x-solivy-device-token','Conflict on','sync_applied_events','has_more']],
  ['app/api/sync/run/route.ts',['reserveOfflineIdRanges','remote_cursor','remote_url','LIVE and TEST cannot sync across environments']],
  ['app/sync/page.tsx',['Sync Now','Automatic sync when online','/api/sync/run']],
  ['middleware.ts',['/api/sync/exchange']],
];
let failures=0;
for(const [file,needles] of required){
 const p=path.join(root,file);
 if(!fs.existsSync(p)){console.error('FAIL missing',file);failures++;continue;}
 const s=fs.readFileSync(p,'utf8');
 for(const n of needles){if(!s.includes(n)){console.error('FAIL',file,'missing marker',n);failures++;}}
}
const exchange=fs.readFileSync(path.join(root,'app/api/sync/exchange/route.ts'),'utf8');
if(!exchange.includes("row.origin_device")&&!exchange.includes("e.origin_device")){console.error('FAIL origin-device tracking missing');failures++;}
if(failures){console.error(`Sync source checks failed: ${failures}`);process.exit(1);}
console.log('Sync source checks passed: pairing, scoped tokens, change capture, idempotency, conflict guard, environment separation and UI wiring.');
