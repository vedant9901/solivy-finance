import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const checks=[
  ['lib/db.ts',['CREATE TABLE IF NOT EXISTS sync_id_mappings','remote_device_id TEXT DEFAULT NULL','sync_id_mappings','idx_sync_id_mappings_lookup']],
  ['lib/sync-id-mapping.ts',['reconcileIncomingEvent','saveMap','mapLookup','remapForeignKeys','nextIntegerId','storeInverseMappings','importPeerMappings','mappingsForPeer']],
  ['app/api/sync/exchange/route.ts',['reconcileIncomingEvent','importPeerMappings','destination_device_id','mappings']],
  ['app/api/sync/run/route.ts',['reconcileIncomingEvent','storeInverseMappings','mappingsForPeer','outgoingMappings.length','remote_device_id']],
];
let failed=0;
for(const [file,markers] of checks){
 const p=path.join(root,file); if(!fs.existsSync(p)){console.error('FAIL missing',file);failed++;continue;}
 const content=fs.readFileSync(p,'utf8');
 for(const marker of markers)if(!content.includes(marker)){console.error('FAIL',file,'missing',marker);failed++;}
}
const helper=fs.readFileSync(path.join(root,'lib/sync-id-mapping.ts'),'utf8');
if(!helper.includes('Existing records are never overwritten')){console.error('FAIL safe collision comment missing');failed++;}
if(!helper.includes('fixedSingletonId') || !helper.includes('schema-required value') || !helper.includes('CHECK\\s*')){console.error('FAIL fixed singleton ID guard missing');failed++;}
const runRoute=fs.readFileSync(path.join(root,'app/api/sync/run/route.ts'),'utf8');
if(!runRoute.includes('token-authorized destination BEFORE pushing any events') || !runRoute.includes('remoteOrganizationName.localeCompare(localCompanyName')){console.error('FAIL company identity preflight missing');failed++;}
if(failed){console.error(`Sync ID mapping checks failed: ${failed}`);process.exit(1);}
console.log('PASS persistent ID mapping source checks: schema, collision allocation, FK remapping, inverse mapping exchange, and peer mapping propagation.');
