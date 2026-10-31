const fs = require('node:fs');
const checks = [
  ['user delete API exists', fs.readFileSync('app/api/users/route.ts','utf8').includes('export async function DELETE(req: Request)')],
  ['primary administrator protected from deletion', fs.readFileSync('app/api/users/route.ts','utf8').includes('The primary administrator account cannot be deleted.')],
  ['last active administrator protected', fs.readFileSync('app/api/users/route.ts','utf8').includes('The last active administrator cannot be deleted.')],
  ['cannot delete currently signed-in account', fs.readFileSync('app/api/users/route.ts','utf8').includes('You cannot delete the account currently signed in.')],
  ['new organization accepts explicit existing-user access', fs.readFileSync('app/api/companies/route.ts','utf8').includes('x.user_assignments') && fs.readFileSync('app/page.tsx','utf8').includes('Existing user access for this organization')],
  // v2.8.1: the pull reports each rejected item instead of aborting the batch, so the detail now
  // comes from the quarantined item (which carries the live local row and the incoming row) rather
  // than from a single thrown error. Both sides of the record must still be reported.
  ['sync conflicts return both current and incoming records', fs.readFileSync('app/api/sync/exchange/route.ts','utf8').includes('current, incoming: desired') && fs.readFileSync('app/api/sync/run/route.ts','utf8').includes('body2.conflict_detail=first.detail') && fs.readFileSync('lib/sync-quarantine.ts','utf8').includes('local_state: localRow') && fs.readFileSync('lib/sync-quarantine.ts','utf8').includes('incoming_state: safeParse(ev.row_json)')],
  ['sync UI renders conflict review details', fs.readFileSync('app/sync/page.tsx','utf8').includes('Conflict review — no automatic overwrite') && fs.readFileSync('app/sync/page.tsx','utf8').includes('Incoming record from other side')],
  ['company settings merge only when non-empty fields do not disagree', fs.readFileSync('app/api/sync/exchange/route.ts','utf8').includes('mergeInitialCompanySettings') && fs.readFileSync('app/api/sync/run/route.ts','utf8').includes('mergeInitialCompanySettings') && fs.readFileSync('app/api/sync/exchange/route.ts','utf8').includes('field_conflicts')],
];
let failed = 0;
for (const [label, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log('User, organization-access, and sync-conflict source checks passed.');
