const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
let failed = 0;
const mustExist = ['middleware.ts','lib/session.ts','lib/security.ts','app/api/login/route.ts','app/api/logout/route.ts','app/page.tsx'];
for (const f of mustExist) {
  if (!fs.existsSync(path.join(root,f))) { console.error(`FAIL missing ${f}`); failed++; }
}
const session = fs.readFileSync(path.join(root,'lib/session.ts'),'utf8');
const middleware = fs.readFileSync(path.join(root,'middleware.ts'),'utf8');
const security = fs.readFileSync(path.join(root,'lib/security.ts'),'utf8');
const login = fs.readFileSync(path.join(root,'app/api/login/route.ts'),'utf8');
const page = fs.readFileSync(path.join(root,'app/page.tsx'),'utf8');
const db = fs.readFileSync(path.join(root,'lib/db.ts'),'utf8');
const setup = fs.readFileSync(path.join(root,'app/api/setup/route.ts'),'utf8');
const reset = fs.readFileSync(path.join(root,'app/api/reset-password/route.ts'),'utf8');
const forgot = fs.readFileSync(path.join(root,'app/api/forgot-password/route.ts'),'utf8');
const checks = [
  ['license verifier present', fs.readFileSync(path.join(root,'middleware.ts'),'utf8').includes('validateLicenseToken')],
  ['admin can reach license recovery shell after license failure', middleware.includes("session.r === 'ADMIN' && path === '/'") && middleware.includes('adminLicenseRecovery')],
  ['expired license still blocks financial APIs', middleware.includes("status: 402") && middleware.includes("code: 'LICENSE_REQUIRED'")],
  ['admin-only organization license status API', fs.existsSync(path.join(root,'app/api/license/status/route.ts')) && fs.readFileSync(path.join(root,'app/api/license/status/route.ts'),'utf8').includes("session.r !== 'ADMIN'")],
  ['license module is in admin navigation', page.includes("['license','License Management']") && page.includes("tab==='license'&&role==='ADMIN'")],
  ['license view includes expiry and module entitlements', fs.readFileSync(path.join(root,'app/components/LicenseManagement.tsx'),'utf8').includes('daysRemaining') && fs.readFileSync(path.join(root,'app/components/LicenseManagement.tsx'),'utf8').includes('Included modules')],
  ['license tool present', fs.existsSync(path.join(root,'scripts/license-tool.cjs'))],
  ['setup authorization enforced', fs.readFileSync(path.join(root,'app/api/setup/route.ts'),'utf8').includes('SOLIVY_SETUP_SECRET')],
  ['no default administrator seeding in db', !fs.readFileSync(path.join(root,'lib/db.ts'),'utf8').includes("VALUES('admin','Administrator','ADMIN','admin123')")],
  ['lazy SESSION_SECRET resolution', session.includes('function getSecret()')],
  ['timing-safe password verification', session.includes('crypto.timingSafeEqual')],
  ['httpOnly session cookie', session.includes('httpOnly: true')],
  ['HTTPS-aware secure cookie', session.includes('x-forwarded-proto') && session.includes("protocol === 'https:'")],
  ['CSRF same-origin enforcement', security.includes('sameOrigin') && middleware.includes('authorizeRequest')],
  ['security headers', middleware.includes('securityHeaders')],
  ['request-size limit', middleware.includes('Request body is too large')],
  ['login rate limiting', login.includes('checkLoginRateLimit') && login.includes('recordLoginFailure')],
  ['mobile Tailwind header grid', page.includes('grid-cols-2') && page.includes('sm:flex')],
  ['mobile responsive table cards', page.includes('md:hidden') && page.includes('md:block')],
  ['no old production Secure-cookie expression', !fs.readFileSync(path.join(root,'app/api/switch-company/route.ts'),'utf8').includes("secure:process.env.NODE_ENV==='production'")],
  ['test-to-live uses session company', fs.readFileSync(path.join(root,'app/api/test-to-live/route.ts'),'utf8').includes("req.headers.get('x-aksh-company-id')")],
  ['viewer read-only policy', fs.readFileSync(path.join(root,'lib/security.ts'),'utf8').includes('Viewer access is read-only.')],
  ['no seeded default admin/tester passwords', !db.includes("VALUES('admin','Administrator','ADMIN','admin123')") && !db.includes("VALUES('tester','Test User','TESTER','test123')")],
  ['secure first-run administrator setup', setup.includes('count !== 0') && setup.includes('hashPassword(password)') && setup.includes('password.length < 12')],
  ['session-bound LIVE/TEST helper exists', db.includes('export function sessionMode(req: Request)')],
  ['menu entitlements enforced in API middleware', security.includes('Server-side menu entitlement checks') && security.includes('session?.a')],
  ['password reset tokens hashed and expiring', forgot.includes('createHash') && forgot.includes('expires_at') && reset.includes('used_at IS NULL')],
  ['reset passwords are scrypt-hashed', reset.includes('hashPassword(password)')],
  ['password recovery email does not embed credentials', forgot.includes('RESEND_API_KEY') && !forgot.includes('password:')],
];
for (const [name,ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if (!ok) failed++; }
const forbiddenIconImports = [];
function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    if (['node_modules','.next','.git'].includes(n)) continue;
    const f=path.join(dir,n); const st=fs.statSync(f);
    if(st.isDirectory()) walk(f); else if(/\.(ts|tsx)$/.test(n)) {
      const s=fs.readFileSync(f,'utf8');
      if (/from\s+['"](?:lucide|@heroicons)/.test(s)) forbiddenIconImports.push(path.relative(root,f));
    }
  }
}
walk(root);
if (forbiddenIconImports.length) { console.error('FAIL unexpected icon package imports:', forbiddenIconImports.join(', ')); failed++; }
if (failed) process.exit(1);
console.log('PASS security/responsive audit');
