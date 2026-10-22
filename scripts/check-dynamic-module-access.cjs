const fs = require('node:fs');
const checks = [
  ['user save catalog contains party aliases', fs.readFileSync('app/api/users/route.ts','utf8').includes("'party-aliases'")],
  ['user save catalog contains transfers', fs.readFileSync('app/api/users/route.ts','utf8').includes("'transfers'")],
  ['login catalog contains party aliases', fs.readFileSync('app/api/login/route.ts','utf8').includes("'party-aliases'")],
  ['login catalog contains transfers', fs.readFileSync('app/api/login/route.ts','utf8').includes("'transfers'")],
  ['user save uses transaction', fs.readFileSync('app/api/users/route.ts','utf8').includes('saveTransaction=d.transaction')],
  ['license feature gate recognizes menu assignments', fs.readFileSync('middleware.ts','utf8').includes('featureAssignedToSession(session, requiredFeatureForPath(path))')],
  ['transfer API mapped to intercompany feature', fs.readFileSync('middleware.ts','utf8').includes("['/api/transfers','intercompany-transfers']")],
  ['party aliases API has explicit feature mapping', fs.readFileSync('middleware.ts','utf8').includes("['/api/party-aliases','party-aliases']")],
  ['server-side menu checks still enforced', fs.readFileSync('lib/security.ts','utf8').includes('Server-side menu entitlement checks')],
];
let failed=0; for (const [name,ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) failed++; }
if(failed) process.exit(1); console.log(`Dynamic module access checks: ${checks.length}/${checks.length} passed`);
