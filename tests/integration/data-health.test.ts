import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk, seedUser, login } from '../helpers/app';
import { db } from '../../lib/db';

test('legacy TDS receivable: GET is a dry run, POST repairs only after confirm, non-admin refused', async () => {
  const s = await adminSession();
  const d = db('LIVE', s.companyId);
  // Reproduce the exact legacy state left by older builds.
  d.prepare("INSERT INTO parties(id,name) VALUES(901,'Legacy Buyer')").run();
  d.prepare("INSERT INTO company_accounts(id,account_name,bank_name,opening_balance) VALUES(901,'Bank','B',0)").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,purchase_date,gross_weight,net_weight,rate,gross_amount,discount_amount,quality_deduct_amount,total_deduction,net_payable) VALUES(901,'L-1',901,'2026-04-01',1,1,1000,1000,0,0,0,1000)").run();
  d.prepare("INSERT INTO financing_receivables(id,purchase_id,party_id,bill_no,bill_date,cost_amount,receivable_amount,received_amount,net_received,tds_amount,status) VALUES(901,901,901,'B-1','2026-04-01',1000,1000,990,990,10,'OPEN')").run();
  d.prepare("INSERT INTO account_transactions(account_id,transaction_date,transaction_type,amount,reference_type,reference_id) VALUES(901,'2026-04-10','CREDIT',990,'FINANCE_RECEIPT',901)").run();
  const diag = expectOk(await call('/api/admin/data-health', { cookie: s.cookie }));
  assert.ok(diag.issues.some((i: any) => i.code === 'LEGACY_TDS_RECEIVABLE'));
  assert.equal((d.prepare('SELECT status FROM financing_receivables WHERE id=901').get() as any).status, 'OPEN', 'GET must not repair');
  assert.equal((await call('/api/admin/data-health', { cookie: s.cookie, body: { action: 'settle_legacy_tds', ids: [901] } })).status, 400, 'confirm required');
  const fixed = expectOk(await call('/api/admin/data-health', { cookie: s.cookie, body: { action: 'settle_legacy_tds', ids: [901], confirm: true } }));
  assert.deepEqual(fixed.affected, [901]);
  assert.equal((d.prepare('SELECT status FROM financing_receivables WHERE id=901').get() as any).status, 'RECEIVED');
  assert.ok(d.prepare("SELECT 1 FROM audit_logs WHERE entity='admin/data-health'").get(), 'repair audited');
  const u = `acct_${Date.now()}`;
  await seedUser({ username: u, role: 'ACCOUNTANT', companies: [{ id: s.companyId }], menu: ['dashboard'] });
  assert.equal((await call('/api/admin/data-health', { cookie: await login(u, s.companyId) })).status, 403);
});
