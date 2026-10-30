// Loaded with `node --require ./tests/setup/register.cjs` before tsx.
// Redirects `next/server` to the test shim when the real Next.js package is not installed,
// and gives every test process an isolated temporary data directory.
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let realNext = false;
try { require.resolve('next/server', { paths: [process.cwd()] }); realNext = true; } catch {}
const shim = path.join(__dirname, '..', 'shims', 'next-server.ts');
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (!realNext && request === 'next/server') return original.call(this, shim, ...rest);
  return original.call(this, request, ...rest);
};

if (!process.env.FINANCE_DATA_DIR) {
  process.env.FINANCE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-test-'));
}
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-' + 'x'.repeat(40);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SOLIVY_TEST_NEXT_SHIM = realNext ? '0' : '1';
