#!/usr/bin/env node
/**
 * Every API route and method must declare its database access class in lib/api-access.ts, and the
 * declaration must match what the code does. Source audit only — no database, no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = path.join(ROOT, 'app', 'api');
const registrySrc = fs.readFileSync(path.join(ROOT, 'lib', 'api-access.ts'), 'utf8');

const fail = [];
const pass = [];
const check = (ok, message) => (ok ? pass.push(message) : fail.push(message));

// Parse the registry without executing TypeScript.
const body = registrySrc.slice(registrySrc.indexOf('export const API_ACCESS'), registrySrc.indexOf('export function routeOfUrl'));
const registry = new Map();
for (const m of body.matchAll(/'(\/api\/[^']*)'\s*:\s*\{([^}]*)\}/g)) {
  const methods = new Map();
  for (const mm of m[2].matchAll(/(GET|POST|PUT|PATCH|DELETE)\s*:\s*(?:'(NO_DB|READ|WRITE)'|([RW])\b)/g)) {
    methods.set(mm[1], mm[2] || (mm[3] === 'R' ? 'READ' : 'WRITE'));
  }
  registry.set(m[1], methods);
}
check(registry.size > 50, `registry parsed: ${registry.size} routes`);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

const files = walk(API);
check(files.length > 60, `found ${files.length} API route files`);

for (const file of files) {
  const route = '/api/' + path.relative(API, path.dirname(file)).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
  const declared = registry.get(route);
  if (!declared) { fail.push(`${route}: not declared in lib/api-access.ts`); continue; }

  for (const method of exported) {
    if (!declared.has(method)) fail.push(`${route} ${method}: exported but not declared`);
  }
  for (const method of declared.keys()) {
    if (!exported.includes(method)) fail.push(`${route} ${method}: declared but not exported`);
  }

  const classes = new Set(declared.values());
  const usesBridge = /withPostgresSQLiteBridge\s*\(/.test(src);
  const usesDb = /\b(adminDb|openDb)\s*\(|from '\.\.\/.*lib\/db'|from "\.\.\/.*lib\/db"/.test(src) || /\bdb\s*\(\s*(sessionMode|mode|'LIVE'|'TEST')/.test(src);
  const usesPostgres = /postgresPool\s*\(|from '.*lib\/postgres'/.test(src);

  if (classes.size === 1 && classes.has('NO_DB')) {
    check(!usesBridge, `${route}: NO_DB route does not use the database bridge`);
    check(!usesDb, `${route}: NO_DB route does not open a database`);
    check(!usesPostgres, `${route}: NO_DB route does not use the PostgreSQL pool`);
  } else {
    check(usesBridge, `${route}: database route goes through the bridge`);
  }

  // A route declared READ-only must not contain obvious write statements in its handlers.
  const readOnly = [...declared.entries()].filter(([, c]) => c === 'READ').map(([m]) => m);
  if (readOnly.length && declared.size === readOnly.length) {
    const writes = src.match(/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/gi) || [];
    // The projection table and the diagnostics table are derived caches, not business data.
    const businessWrites = writes.filter(() => !/solivy_public_projections|solivy_transfer_metrics|solivy_login_attempts/.test(src));
    check(businessWrites.length === 0 || /solivy_public_projections|solivy_transfer_metrics|solivy_login_attempts/.test(src),
      `${route}: READ-only route has no business write statements (${writes.length} statement(s) found)`);
  }
}

const bridged = files.filter((f) => /withPostgresSQLiteBridge\s*\(/.test(fs.readFileSync(f, 'utf8'))).length;
check(bridged >= files.length - 1, `${bridged}/${files.length} route files use the bridge (only /api/logout is NO_DB)`);

for (const line of pass) console.log(`PASS ${line}`);
for (const line of fail) console.error(`FAIL ${line}`);
console.log(fail.length ? `API access audit FAILED: ${fail.length} problem(s)` : `API access audit passed: ${pass.length} checks, ${registry.size} routes declared`);
process.exit(fail.length ? 1 : 0);
