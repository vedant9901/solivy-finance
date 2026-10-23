const fs = require('fs');
const path = require('path');
const login = fs.readFileSync(path.join(process.cwd(), 'app/api/login/route.ts'), 'utf8');
const companies = fs.readFileSync(path.join(process.cwd(), 'app/api/companies/route.ts'), 'utf8');
const loginCompanies = fs.readFileSync(path.join(process.cwd(), 'app/api/login-companies/route.ts'), 'utf8');
const checks = [
  ['login route uses bridged admin database', login.includes("const d = adminDb();") && login.includes('withPostgresSQLiteBridge')],
  ['login no longer has a separate native-PG auth source', !login.includes('SOLIVY_NATIVE_PG_AUTH') && !login.includes('postgresPool')],
  ['login validates user-company environment mapping', login.includes('SELECT can_live,can_test FROM user_companies WHERE user_id=? AND company_id=?')],
  ['login requires active destination organization', login.includes('FROM companies WHERE id=? AND active=1')],
  ['company creation persists explicit user assignments', companies.includes('x.user_assignments') && companies.includes('INSERT OR REPLACE INTO user_companies')],
  ['login organization selector reads active organizations from same database', loginCompanies.includes('SELECT id, name, code FROM companies WHERE active = 1') && loginCompanies.includes('withPostgresSQLiteBridge')],
];
let fail = false;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fail = true; }
if (fail) process.exit(1);
console.log(`Online login organization regression checks passed: ${checks.length}/${checks.length}`);
