#!/usr/bin/env node
/**
 * v2.8.2 — live API probe, for finding a 404 in a running deployment.
 *
 * The repository's API surface is verified by `scripts/check-api-routes.cjs`. If a deployed build
 * still answers 404 for a route, this probes the running site and reports, per route, what it
 * actually returns, so the missing routes in *that* build are identified rather than guessed.
 *
 *   node scripts/check-api-live.mjs https://your-site.example            # unauthenticated
 *   node scripts/check-api-live.mjs https://your-site.example <session>  # aksh_session cookie value
 *
 * Reads only: it sends GET for routes that export GET, and nothing else. 401/402/403 are expected
 * without a session and are reported as "present". 404 means the route is absent from that build.
 * Nothing is written and no credential is printed.
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || '').replace(/\/+$/, '');
const session = process.argv[3] || '';
if (!base) { console.error('usage: node scripts/check-api-live.mjs <base-url> [aksh_session cookie value]'); process.exit(2); }

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'api-route-manifest.json'), 'utf8')).routes || {};
const gets = Object.entries(manifest).filter(([, methods]) => methods.includes('GET')).map(([url]) => url);

const probe = async (url) => {
  const target = `${base}${url}${url === '/api/data' ? '?modules=core' : ''}`;
  try {
    const r = await fetch(target, { headers: { ...(session ? { cookie: `aksh_session=${session}` } : {}), 'x-aksh-mode': 'LIVE' }, redirect: 'manual' });
    return r.status;
  } catch (e) { return `ERR ${String(e?.message || e).slice(0, 60)}`; }
};

const missing = [];
const other = [];
for (const url of gets) {
  const status = await probe(url);
  if (status === 404) { missing.push(url); console.log(`404  ${url}   <- ABSENT from this build`); }
  else if (typeof status === 'number' && status < 500) console.log(`${String(status).padEnd(4)} ${url}`);
  else { other.push([url, status]); console.log(`${String(status).padEnd(4)} ${url}   <- investigate`); }
}
console.log('');
console.log(`probed ${gets.length} GET routes · ${missing.length} returned 404 · ${other.length} returned 5xx or failed`);
if (missing.length) {
  console.log('');
  console.log('These routes exist in the source but not in the running build. That is a packaging or');
  console.log('deployment problem, not an application error: rebuild and redeploy from a checkout that');
  console.log('contains app/api in full, then run scripts/check-api-routes.cjs against the artefact.');
  process.exit(1);
}
process.exit(other.length ? 1 : 0);
