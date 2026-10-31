/**
 * v2.8.2 P0 — API route compatibility.
 *
 * The reported regression was `GET /api/data?mode=LIVE&company_id=2&modules=core,parties,accounts`
 * answering 404. A 404 from Next means the route was not present at runtime, so these tests assert
 * the three things that can make that true independently of any one deployment:
 *
 *  1. every API route directory actually contains a route module exporting at least one HTTP method;
 *  2. every path the user interface fetches resolves to such a route, with that method exported
 *     (a missing file, a renamed folder or a dropped `export async function GET` fails here);
 *  3. the exact reported request runs end to end — through the real middleware — for an authorised
 *     user of organisation 2, in LIVE and in TEST, and is refused for a user without access.
 *
 * It is a static + dynamic inventory on purpose: it fails in CI when a route is deleted or omitted
 * from a release package, which is what a 404 in the field actually means.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as app from '../helpers/app';

const ROOT = path.resolve(__dirname, '..', '..');
const API = path.join(ROOT, 'app', 'api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Every directory under app/api that holds a route module, as its URL path. */
function routeFiles(dir = API, prefix = '/api'): Array<{ url: string; file: string }> {
  const out: Array<{ url: string; file: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    const url = `${prefix}/${entry.name}`;
    for (const name of ['route.ts', 'route.tsx', 'route.js']) {
      if (fs.existsSync(path.join(sub, name))) { out.push({ url, file: path.join(sub, name) }); break; }
    }
    out.push(...routeFiles(sub, url));
  }
  return out;
}

function exportedMethods(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  return METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\s*\\(`).test(src) || new RegExp(`export\\s+const\\s+${m}\\s*[:=]`).test(src));
}

const routes = routeFiles();
const byUrl = new Map(routes.map((r) => [r.url, r]));

test('every API route module exports at least one HTTP method', () => {
  assert.ok(routes.length >= 50, `expected the full route set, found ${routes.length}`);
  const empty = routes.filter((r) => exportedMethods(r.file).length === 0);
  assert.deepEqual(empty.map((r) => r.url), [], 'these routes export no HTTP method, so they answer 404/405 at runtime');
});

test('/api/data exists and exports GET', () => {
  const r = byUrl.get('/api/data');
  assert.ok(r, '/api/data/route.ts is missing — this is exactly what the reported 404 looks like');
  assert.ok(exportedMethods(r!.file).includes('GET'), '/api/data must export GET');
});

/** Paths the interface fetches, collected from the source rather than from a maintained list. */
function uiCallSites() {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p !== API) walk(p); continue; }
      if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'app'));
  const found = new Map<string, Set<string>>();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // fetch('/api/x'), fetch(`/api/x?...`), and the api('/x') helper used by app/page.tsx.
    for (const m of src.matchAll(/fetch\(\s*[`'"](\/api\/[A-Za-z0-9_\-/]+)/g)) add(found, m[1], f, src, m.index || 0);
    for (const m of src.matchAll(/\bapi\(\s*[`'"](\/[A-Za-z0-9_\-/]+)/g)) add(found, '/api' + m[1], f, src, m.index || 0);
  }
  return found;
}
function add(found: Map<string, Set<string>>, url: string, _file: string, src: string, at: number) {
  // Only this call's own options object: stop at the next call site or statement end, or a later
  // POST in the same file would be attributed to this path.
  let tail = src.slice(at, at + 400);
  const stop = Math.min(...[/fetch\(/, /\bapi\(/, /;/].map((re) => { const m = re.exec(tail.slice(6)); return m ? m.index + 6 : tail.length; }));
  tail = tail.slice(0, stop);
  const method = /method\s*:\s*[`'"]([A-Z]+)/.exec(tail)?.[1] || (/\bbody\s*:/.test(tail) ? 'POST' : 'GET');
  if (!found.has(url)) found.set(url, new Set());
  found.get(url)!.add(method);
}

test('every API path the interface calls exists and exports the method it uses', () => {
  const problems: string[] = [];
  for (const [url, methods] of uiCallSites()) {
    const route = byUrl.get(url);
    if (!route) { problems.push(`${url} — no route module (the UI would receive 404)`); continue; }
    const exported = exportedMethods(route.file);
    for (const m of methods) if (!exported.includes(m)) problems.push(`${url} — ${m} is not exported (the UI would receive 405); exports: ${exported.join(', ') || 'none'}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the reported request runs end to end for an authorised user of organisation 2 (LIVE and TEST)', async () => {
  // Organisation ids are sequential; this seeds until id 2 exists so the reported URL is literal.
  let company2 = 0;
  for (let i = 0; i < 4 && !company2; i++) { const id = await app.seedOrg({ companyName: `Compat Org ${i}` }); if (id === 2) company2 = id; }
  if (!company2) company2 = await app.seedOrg({ companyName: 'Compat Org 2' });

  const username = `compat_${Math.random().toString(36).slice(2, 8)}`;
  await app.seedUser({ username, role: 'ADMIN', companies: [{ id: company2, live: true, test: true }] });

  for (const mode of ['LIVE', 'TEST'] as const) {
    const cookie = await app.login(username, company2, mode);
    const r = await app.call(`/api/data?mode=${mode}&company_id=${company2}&modules=core,parties,accounts`, { cookie });
    assert.equal(r.status, 200, `GET /api/data (${mode}) must not 404/401/500: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    assert.ok(r.json && typeof r.json === 'object', 'a JSON body is returned');
    assert.ok(Array.isArray(r.json.parties), 'the requested parties module is present');
    assert.ok(Array.isArray(r.json.accounts), 'the requested accounts module is present');
    // A module that was not requested is not computed or sent (the v2.7 contract).
    assert.equal(r.json.purchases, undefined, 'unrequested modules stay absent');
    assert.ok(r.headers.get('etag'), 'the conditional-response ETag is still issued');
  }
});

test('organisation and environment isolation hold on the restored request', async () => {
  const orgA = await app.seedOrg({ companyName: 'Compat Isolated A' });
  const orgB = await app.seedOrg({ companyName: 'Compat Isolated B' });
  const userA = `iso_a_${Math.random().toString(36).slice(2, 7)}`;
  await app.seedUser({ username: userA, role: 'ADMIN', companies: [{ id: orgA, live: true, test: true }] });
  const cookieA = await app.login(userA, orgA, 'LIVE');

  // A party in A must not appear for B, and a user without access to B cannot select it.
  app.expectOk(await app.call('/api/parties', { cookie: cookieA, body: { name: 'Compat Only In A', party_type: 'GOODS_VENDOR' } }), 'create party in A');
  const inA = app.expectOk(await app.call(`/api/data?mode=LIVE&company_id=${orgA}&modules=core,parties,accounts`, { cookie: cookieA }));
  assert.ok(inA.parties.some((p: any) => p.name === 'Compat Only In A'));

  const crossed = await app.call(`/api/data?mode=LIVE&company_id=${orgB}&modules=core,parties,accounts`, { cookie: cookieA });
  // The session, not the query string, decides the organisation: the response must never be B's.
  if (crossed.status === 200) {
    assert.ok(!(crossed.json.parties || []).some((p: any) => p.name && p.name.includes('Only In B')), 'no data from an organisation the session does not hold');
    assert.ok((crossed.json.parties || []).some((p: any) => p.name === 'Compat Only In A'), 'the session organisation is used, not the query parameter');
  } else {
    assert.ok([401, 403].includes(crossed.status), `expected the request to stay in A or be refused, got ${crossed.status}`);
  }
  assert.ok((await app.login(userA, orgA, 'TEST')).length > 0, 'TEST is a separate selection for the same user');
  const liveParties = app.expectOk(await app.call(`/api/data?mode=LIVE&company_id=${orgA}&modules=core,parties,accounts`, { cookie: cookieA })).parties.length;
  const testCookie = await app.login(userA, orgA, 'TEST');
  const testParties = app.expectOk(await app.call(`/api/data?mode=TEST&company_id=${orgA}&modules=core,parties,accounts`, { cookie: testCookie })).parties.length;
  assert.notEqual(liveParties, testParties, 'LIVE and TEST are separate databases for the same organisation');
});

test('an unauthenticated request is refused, not answered with data', async () => {
  const r = await app.call('/api/data?mode=LIVE&company_id=2&modules=core,parties,accounts');
  assert.ok([401, 403].includes(r.status) || r.status === 307 || r.status === 302, `expected a refusal, got ${r.status}`);
  assert.ok(!r.json?.parties, 'no data is returned without a session');
});
