#!/usr/bin/env node
/**
 * v2.8.2 — API surface guard.
 *
 * A 404 from a deployed build means the route was not present at runtime. This compares the
 * repository's API surface with `scripts/api-route-manifest.json` and fails if any route, or any
 * exported HTTP method, that the baseline had is missing. New routes and new methods are allowed;
 * removals require updating the manifest deliberately in the same change.
 *
 * Run it on the unpacked release as well as on the repository: a route that exists in git but was
 * dropped from the package fails here too.
 *
 *   node scripts/check-api-routes.cjs            # this checkout
 *   node scripts/check-api-routes.cjs <dir>      # an unpacked release directory
 */
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const manifestPath = path.join(root, 'scripts', 'api-route-manifest.json');
const apiDir = path.join(root, 'app', 'api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

if (!fs.existsSync(manifestPath)) { console.error(`FAIL manifest missing: ${manifestPath}`); process.exit(1); }
if (!fs.existsSync(apiDir)) { console.error(`FAIL app/api is missing from ${root} — every API would answer 404`); process.exit(1); }

function inventory(dir) {
  const found = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'route.ts' && e.name !== 'route.tsx' && e.name !== 'route.js') continue;
      const src = fs.readFileSync(p, 'utf8');
      const url = '/' + path.relative(path.join(root, 'app'), d).split(path.sep).join('/');
      found[url] = METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\s*\\(`).test(src) || new RegExp(`export\\s+const\\s+${m}\\s*[:=]`).test(src));
    }
  })(dir);
  return found;
}

const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).routes || {};
const actual = inventory(apiDir);
const problems = [];

for (const [url, methods] of Object.entries(expected)) {
  if (!actual[url]) { problems.push(`MISSING ROUTE ${url} — requests to it return 404`); continue; }
  for (const m of methods) if (!actual[url].includes(m)) problems.push(`MISSING METHOD ${m} ${url} — requests with that method return 405`);
}
for (const [url, methods] of Object.entries(actual)) {
  if (!methods.length) problems.push(`NO METHOD EXPORTED ${url} — the file exists but answers nothing`);
}

const added = Object.keys(actual).filter((u) => !expected[u]);
for (const p of problems) console.error(`FAIL ${p}`);
if (added.length) console.log(`note: ${added.length} route(s) added since the manifest: ${added.join(', ')}`);
if (problems.length) { console.error(`FAIL ${problems.length} API surface regression(s) against the manifest`); process.exit(1); }
console.log(`PASS API surface: ${Object.keys(actual).length} routes, ${Object.values(actual).reduce((a, b) => a + b.length, 0)} exported methods; every baseline route and method is present`);
