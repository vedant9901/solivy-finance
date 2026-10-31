#!/usr/bin/env node
/**
 * v2.8.2 — release package completeness.
 *
 * v2.8.1 shipped a ZIP that was missing `app/api/data/route.ts`, so every deployment built from it
 * answered `GET /api/data` with 404. The cause was the packaging command: `tar --exclude=data`
 * matches a directory called `data` at ANY depth, so `app/api/data/` was dropped with the runtime
 * data directory. Excludes must be anchored (`./data`), and a package must be verified before it
 * is shipped.
 *
 *   node scripts/check-release-package.mjs <unpacked-release-dir>
 *
 * Fails if the package is missing any source file this checkout has (ignoring the directories that
 * are deliberately excluded), and runs the API surface guard over it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const target = process.argv[2];
if (!target) { console.error('usage: node scripts/check-release-package.mjs <unpacked-release-dir>'); process.exit(2); }
const root = process.cwd();
const dir = path.resolve(target);
if (!fs.existsSync(dir)) { console.error(`FAIL ${dir} does not exist`); process.exit(1); }

const SKIP_DIRS = new Set(['node_modules', '.next', 'data', 'test-results', 'playwright-report', '.git']);
const SKIP_FILE = (name) => /\.(db|db-wal|db-shm|log)$/.test(name) || name === '.env' || name === '.env.local';

function list(base) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !(rel === '' && e.name.startsWith('.git'))) walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
      if (SKIP_FILE(e.name)) continue;
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  })(base, '');
  return new Set(out);
}

const expected = list(root);
const actual = list(dir);
const missing = [...expected].filter((f) => !actual.has(f)).sort();

if (missing.length) {
  for (const f of missing.slice(0, 40)) console.error(`FAIL missing from package: ${f}`);
  if (missing.length > 40) console.error(`FAIL …and ${missing.length - 40} more`);
  console.error(`FAIL the package is missing ${missing.length} file(s) that this checkout has`);
  process.exit(1);
}
try { execFileSync(process.execPath, [path.join(root, 'scripts', 'check-api-routes.cjs'), dir], { stdio: 'inherit' }); }
catch { process.exit(1); }
console.log(`PASS release package: ${actual.size} files, nothing missing against this checkout`);
