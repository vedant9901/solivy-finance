import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, adminSession, expectOk } from '../helpers/app';

test('login → create party, account, purchase → /api/data reflects it', async () => {
  const { cookie } = await adminSession();
  expectOk(await call('/api/parties', { cookie, body: { name: 'Vendor A', party_type: 'GOODS_VENDOR' } }), 'party');
  expectOk(await call('/api/accounts', { cookie, body: { account_name: 'Main Bank', bank_name: 'HDFC', account_type: 'BANK', opening_balance: 100000, opening_date: '2026-04-01' } }), 'account');
  const data = expectOk(await call('/api/data', { cookie }), 'data');
  const party = data.parties.find((p: any) => p.name === 'Vendor A');
  assert.ok(party, 'party present');
  const p = expectOk(await call('/api/purchases', { cookie, body: { party_id: party.id, purchase_date: '2026-05-01', net_weight: 1000, gross_weight: 1010, rate: 25, truck_number: 'MH12AB1234' } }), 'purchase');
  assert.equal(p.calc.net_payable, 25000);
  const after = expectOk(await call('/api/data', { cookie }), 'data2');
  assert.equal(after.purchases.length, 1);
  assert.equal(after.accounts[0].balance, 100000);
});

test('unauthenticated API call is rejected', async () => {
  const r = await call('/api/data');
  assert.equal(r.status, 401);
});
