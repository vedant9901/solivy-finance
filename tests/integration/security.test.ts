import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { call, seedOrg, seedUser, login, adminSession, expectOk } from '../helpers/app';
import { adminDb, db, closeAllDatabases } from '../../lib/db';
import { middleware } from '../../middleware';

const uniq = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

test('client-supplied x-aksh-* identity headers are stripped on public and authenticated routes', async () => {
  const req = new NextRequest('http://localhost:3000/api/login', { method: 'POST', headers: { 'x-aksh-role': 'ADMIN', 'x-aksh-user': 'mallory', 'x-aksh-company-id': '9', origin: 'http://localhost:3000' } });
  const res: any = await middleware(req);
  for (const h of ['x-aksh-role', 'x-aksh-user', 'x-aksh-company-id']) assert.equal(res.__requestHeaders.get(h), null, h);
  const forged = await call('/api/data', { headers: { 'x-aksh-role': 'ADMIN', 'x-aksh-user': 'admin', 'x-aksh-company-id': '1', 'x-aksh-mode': 'LIVE', 'x-aksh-authenticated': '1' } });
  assert.equal(forged.status, 401);
});

test('organization isolation: user cannot log in to, query or spoof another organization', async () => {
  const orgA = await seedOrg(); const orgB = await seedOrg();
  const user = uniq('alice');
  await seedUser({ username: user, role: 'ADMIN', companies: [{ id: orgA }] });
  const adminB = await adminSession();
  // put a party in B through B's own admin
  expectOk(await call('/api/parties', { cookie: adminB.cookie, body: { name: 'Secret Vendor B', party_type: 'GOODS_VENDOR' } }));
  await assert.rejects(login(user, orgB), /401/);
  const cookie = await login(user, orgA);
  const viaQuery = expectOk(await call('/api/data', { cookie, query: { company_id: adminB.companyId } }));
  const viaHeader = expectOk(await call('/api/data', { cookie, headers: { 'x-aksh-company-id': String(adminB.companyId) } }));
  for (const d of [viaQuery, viaHeader]) assert.equal(d.parties.some((p: any) => p.name === 'Secret Vendor B'), false);
  const sw = await call('/api/switch-company', { cookie, body: { company_id: adminB.companyId } });
  assert.equal(sw.status, 403);
});

test('LIVE/TEST isolation: environment mismatch is refused; TESTER cannot sign in to LIVE', async () => {
  const org = await seedOrg();
  const t = uniq('tester');
  await seedUser({ username: t, role: 'TESTER', companies: [{ id: org, live: false, test: true }] });
  await assert.rejects(login(t, org, 'LIVE'), /401/);
  const cookie = await login(t, org, 'TEST');
  const r = await call('/api/data', { cookie, headers: { 'x-aksh-mode': 'LIVE' } });
  assert.equal(r.status, 403);
  const live = await adminSession('LIVE');
  expectOk(await call('/api/parties', { cookie: live.cookie, body: { name: 'Only In Live', party_type: 'GOODS_VENDOR' } }));
  const sw = await call('/api/switch-environment', { cookie: live.cookie, body: { mode: 'TEST' } });
  const testData = expectOk(await call('/api/data', { cookie: sw.cookie }));
  assert.equal(testData.parties.some((p: any) => p.name === 'Only In Live'), false);
});

test('module RBAC is enforced server-side; VIEWER is read-only; cross-site writes are blocked', async () => {
  const org = await seedOrg();
  const clerk = uniq('clerk');
  await seedUser({ username: clerk, role: 'DATA_ENTRY', companies: [{ id: org }], menu: ['dashboard', 'purchase'] });
  const cookie = await login(clerk, org);
  assert.equal((await call('/api/payments', { cookie, body: { party_id: 1, amount: 1 } })).status, 403);
  assert.equal((await call('/api/accounts', { cookie })).status, 403);
  const viewer = uniq('viewer');
  await seedUser({ username: viewer, role: 'VIEWER', companies: [{ id: org }], menu: ['dashboard', 'parties'] });
  const vc = await login(viewer, org);
  assert.equal((await call('/api/parties', { cookie: vc, body: { name: 'x' } })).status, 403);
  const { cookie: ac } = await adminSession();
  const csrf = await call('/api/parties', { cookie: ac, body: { name: 'csrf' }, headers: { origin: 'https://evil.example' } });
  assert.equal(csrf.status, 403);
});

test('administrator-only routes: transfer diagnostics and data health refuse other roles', async () => {
  const org = await seedOrg();
  const clerk = uniq('clerk');
  await seedUser({ username: clerk, role: 'DATA_ENTRY', companies: [{ id: org }], menu: ['dashboard', 'purchase', 'reports'] });
  const cookie = await login(clerk, org);
  for (const path of ['/api/admin/transfer-metrics', '/api/admin/data-health']) {
    assert.equal((await call(path, { cookie })).status, 403, path);
    // A forged role header must not help: the middleware replaces identity headers.
    assert.equal((await call(path, { cookie, headers: { 'x-aksh-role': 'ADMIN' } })).status, 403, `${path} with a forged role`);
  }
  const { cookie: ac } = await adminSession();
  const ok = await call('/api/admin/transfer-metrics', { cookie: ac, query: { days: 1 } });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.match(String(ok.json.note), /lower bound|provider/i);
  assert.match(String(ok.json.storage), /^memory/, 'offline installs keep the counters in this process only');
  assert.ok(Array.isArray(ok.json.rows));
});

test('session revocation: deactivation, role change and grant removal end existing sessions', async () => {
  const org = await seedOrg();
  for (const change of ['deactivate', 'role', 'grant'] as const) {
    const u = uniq(change);
    const id = await seedUser({ username: u, role: 'ACCOUNTANT', companies: [{ id: org }], menu: ['dashboard', 'parties'] });
    const cookie = await login(u, org);
    assert.equal((await call('/api/data', { cookie })).status, 200);
    await new Promise((r) => setTimeout(r, 5));
    const a = adminDb();
    if (change === 'deactivate') a.prepare('UPDATE admin_users SET active=0 WHERE id=?').run(id);
    if (change === 'role') a.prepare("UPDATE admin_users SET role='VIEWER' WHERE id=?").run(id);
    if (change === 'grant') a.prepare('DELETE FROM user_companies WHERE user_id=?').run(id);
    const r = await call('/api/data', { cookie });
    assert.equal(r.status, 401, change);
    assert.equal(r.json.code, 'SESSION_REVOKED');
  }
});

test('password change revokes older sessions but the new login works', async () => {
  const org = await seedOrg(); const u = uniq('pw');
  const id = await seedUser({ username: u, role: 'ADMIN', companies: [{ id: org }] });
  const old = await login(u, org);
  await new Promise((r) => setTimeout(r, 5));
  const { hashPassword } = await import('../../lib/session');
  adminDb().prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(hashPassword('New-Password-123'), id);
  assert.equal((await call('/api/data', { cookie: old })).status, 401);
  const fresh = await login(u, org, 'LIVE', 'New-Password-123');
  assert.equal((await call('/api/data', { cookie: fresh })).status, 200);
});

test('legacy plaintext passwords are hashed at rest and the plaintext comparison path is gone', async () => {
  const org = await seedOrg(); const u = uniq('legacy');
  const a = adminDb();
  const r = a.prepare("INSERT INTO admin_users(username,name,role,password,password_hash,active,menu_access) VALUES(?,?, 'ADMIN', 'Legacy-Plain-99', '', 1, '[]')").run(u, u);
  a.prepare('INSERT INTO user_companies(user_id,company_id,can_live,can_test) VALUES(?,?,1,0)').run(Number(r.lastInsertRowid), org);
  closeAllDatabases(); // next open runs the admin v2.7 migration
  const row = adminDb().prepare('SELECT password, password_hash FROM admin_users WHERE username=?').get(u) as any;
  assert.equal(row.password, '');
  assert.match(row.password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  await login(u, org, 'LIVE', 'Legacy-Plain-99');
});

test('login throttling blocks after 5 failures even with the right password', async () => {
  const org = await seedOrg(); const u = uniq('brute');
  await seedUser({ username: u, role: 'ADMIN', companies: [{ id: org }] });
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/login', { body: { username: u, password: 'bad', company_id: org, mode: 'LIVE' } })).status, 401);
  const blocked = await call('/api/login', { body: { username: u, password: 'Correct-Horse-9', company_id: org, mode: 'LIVE' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('idempotency: same key replays, different body is refused, failed request releases the key', async () => {
  const { cookie } = await adminSession();
  const body = { name: 'Idem Party', party_type: 'GOODS_VENDOR' };
  const a = await call('/api/parties', { cookie, body, headers: { 'idempotency-key': 'k-1' } });
  const b = await call('/api/parties', { cookie, body, headers: { 'idempotency-key': 'k-1' } });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(b.headers.get('idempotent-replay'), 'true');
  const c = await call('/api/parties', { cookie, body: { ...body, name: 'Other' }, headers: { 'idempotency-key': 'k-1' } });
  assert.equal(c.status, 409);
  const bad = await call('/api/parties', { cookie, body: { party_type: 'GOODS_VENDOR' }, headers: { 'idempotency-key': 'k-2' } });
  assert.equal(bad.status, 400);
  const retry = await call('/api/parties', { cookie, body: { name: 'Fixed', party_type: 'GOODS_VENDOR' }, headers: { 'idempotency-key': 'k-2' } });
  assert.equal(retry.status, 200, 'a failed request releases its key so the corrected request can be submitted');
  const data = expectOk(await call('/api/data', { cookie }));
  assert.equal(data.parties.filter((p: any) => p.name === 'Idem Party').length, 1);
});

test('successful mutations are audited with secrets redacted', async () => {
  const s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Audited Vendor', party_type: 'GOODS_VENDOR' } }));
  const row = db('LIVE', s.companyId).prepare("SELECT * FROM audit_logs WHERE entity='parties' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(row.username, s.username);
  assert.match(row.details, /Audited Vendor/);
  const u = uniq('newuser');
  const r = await call('/api/users', { cookie: s.cookie, body: { username: u, name: u, role: 'VIEWER', password: 'Super-Secret-Pass-1', email: `${u}@example.test`, assignments: [{ company_id: s.companyId, can_live: 1, can_test: 0 }] } });
  if (r.status === 200) {
    const a = adminDb().prepare("SELECT details FROM admin_audit_logs WHERE entity='users' ORDER BY id DESC LIMIT 1").get() as any;
    assert.ok(a, 'admin audit row');
    assert.doesNotMatch(a.details, /Super-Secret-Pass-1/);
    assert.match(a.details, /\[redacted\]/);
  } else assert.fail(`users POST failed: ${r.text}`);
});

test('license: module missing from license is locked for every role; admin keeps backup recovery', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  process.env.SOLIVY_TEST_LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const s = await adminSession();
  const payload = { product: 'SOLIVY_FINANCE', licenseId: 'test', customer: 'Test', companyIds: [s.companyId], edition: 'standard', features: ['core', 'dashboard', 'parties'], issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  process.env.SOLIVY_LICENSE_ENFORCEMENT = 'required';
  process.env.SOLIVY_LICENSE_TOKEN = `${part}.${crypto.sign(null, Buffer.from(part), privateKey).toString('base64url')}`;
  try {
    assert.equal((await call('/api/data', { cookie: s.cookie })).status, 200);
    const locked = await call('/api/payments', { cookie: s.cookie, body: {} });
    assert.equal(locked.status, 403); assert.equal(locked.json.code, 'LICENSE_FEATURE_LOCKED');
    assert.notEqual((await call('/api/backup', { cookie: s.cookie })).status, 403);
    process.env.SOLIVY_LICENSE_TOKEN = `${part}.${Buffer.alloc(64).toString('base64url')}`;
    const forged = await call('/api/data', { cookie: s.cookie });
    assert.equal(forged.status, 402);
  } finally { delete process.env.SOLIVY_LICENSE_ENFORCEMENT; delete process.env.SOLIVY_LICENSE_TOKEN; }
});

test('edits of financial records are audited with a field-level before/after diff', async () => {
  const s = await adminSession();
  expectOk(await call('/api/parties', { cookie: s.cookie, body: { name: 'Diff Vendor', party_type: 'GOODS_VENDOR' } }));
  const pid = expectOk(await call('/api/data', { cookie: s.cookie })).parties[0].id;
  const id = expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: pid, purchase_date: '2026-06-01', net_weight: 1000, gross_weight: 1000, rate: 40, truck_number: 'T1' } })).id;
  const p = db('LIVE', s.companyId).prepare('SELECT * FROM purchases WHERE id=?').get(id) as any;
  expectOk(await call('/api/purchases', { method: 'PUT', cookie: s.cookie, body: { ...p, rate: 42 } }));
  const row = db('LIVE', s.companyId).prepare("SELECT action, details FROM audit_logs WHERE entity='purchases' ORDER BY id DESC LIMIT 1").get() as any;
  assert.match(row.action, /^EDIT PUT/);
  const changes = JSON.parse(row.details).changes;
  assert.deepEqual(changes.rate, [40, 42]);
  assert.deepEqual(changes.net_payable, [40000, 42000]);
});
