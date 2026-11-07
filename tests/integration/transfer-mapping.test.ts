/**
 * v2.12.3 — inter-company transfer: resolving parties and bank/cash accounts in the destination.
 *
 * The defect these tests lock down: a transfer carried its links **by name**, and the destination
 * had to hold an account named character-for-character the same. Where it did not, the import
 * failed at **accept** — after the transfer had been created and was sitting PENDING — with
 *
 *     Destination organization is missing mapped bank/cash account: Aksh Ent.
 *
 * which named no record, no field, and no account the destination actually has, and left the
 * transfer stuck: the only way out was to rename master data in one of the two organizations.
 *
 * What is asserted here, and what deliberately is not:
 *  - an unmatched link is reported as a choice to make, with the destination's own accounts listed,
 *    and the transfer stays PENDING rather than failing permanently;
 *  - supplying the choice imports the records, posting them to the chosen account;
 *  - a near match ("AKSH ENTERPRISES" for "Aksh Ent.") is offered as a suggestion but is **never
 *    applied on its own** — posting a payment to the wrong bank account silently is worse than
 *    refusing to post it;
 *  - a map may not point at a row outside the destination organization;
 *  - nothing is imported when any link is unresolved — no partial import;
 *  - the choice is recorded in the audit log and on the acceptance receipt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as app from '../helpers/app';
import { db } from '../../lib/db';

/** Two organizations, one user mapped to both, logged in at each. */
async function twoOrgs() {
  const source = await app.seedOrg({ companyName: 'Source Org' });
  const destination = await app.seedOrg({ companyName: 'Destination Org' });
  const username = `xfer_${Math.random().toString(36).slice(2, 8)}`;
  await app.seedUser({ username, role: 'ADMIN', companies: [{ id: source, live: true, test: true }, { id: destination, live: true, test: true }] });
  return {
    source, destination, username,
    sourceCookie: await app.login(username, source, 'LIVE'),
    destCookie: await app.login(username, destination, 'LIVE'),
  };
}

/** A posted payment in the source organization, paid from an account with the given name. */
async function postedPayment(cookie: string, companyId: number, accountName: string) {
  const partyName = `Vendor ${Math.random().toString(36).slice(2, 7)}`;
  const party = app.expectOk(await app.call('/api/parties', { cookie, body: { name: partyName, contact: '9100000000', gst: '', pan: '' } }), 'party');
  const partyId = Number(party.id ?? party.partyId);
  app.expectOk(await app.call('/api/accounts', { cookie, body: { account_name: accountName, bank_name: 'HDFC', account_type: 'BANK', opening_balance: 500000, opening_date: '2026-04-01' } }), 'account');
  const accountId = Number((db('LIVE', companyId).prepare('SELECT id FROM company_accounts WHERE account_name=? ORDER BY id DESC LIMIT 1').get(accountName) as any).id);
  const pay = app.expectOk(await app.call('/api/payments', { cookie, body: { party_id: partyId, payment_date: '2026-06-12', amount: 1000, mode: 'BANK', company_account_id: accountId } }), 'payment');
  return { partyId, accountId, paymentId: Number(pay.id ?? pay.payment_id), partyName };
}

/** Send the payment to the destination and return the transfer id plus the create response. */
async function send(o: any, paymentId: number) {
  const j = app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'payments', ids: [paymentId] } }), 'create');
  return { id: String(j.transfer_id), created: j };
}

/** Mirror the source's party in the destination, so only the account is left unresolved. */
async function mirrorParty(o: any, name: string) {
  app.expectOk(await app.call('/api/parties', { cookie: o.destCookie, body: { name, contact: '9100000000', gst: '', pan: '' } }), 'mirror party');
}

// ---- 1-2: the failure is a choice to make, and it names what is missing ------------------------

test('an account the destination does not have is reported as a choice, with its own accounts listed', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  await mirrorParty(o, made.partyName);
  // The destination keeps its bank under a different name, as a separate organization would.
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'AKSH ENTERPRISES', bank_name: 'ICICI', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const { id } = await send(o, made.paymentId);

  const r = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: id } });
  assert.equal(r.status, 409, `expected a mapping request, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.reason, 'MAPPING_REQUIRED');
  const u = (r.json.unresolved || []).find((x: any) => x.kind === 'account');
  assert.ok(u, `the unmatched account is reported: ${JSON.stringify(r.json.unresolved)}`);
  assert.equal(u.name, 'Aksh Ent.', 'named as the source holds it');
  assert.equal(u.field, 'company_account_id', 'and the field it fills is named');
  assert.ok(u.references?.length, 'with the record that needs it');
  assert.ok(u.candidates.some((c: any) => c.name === 'AKSH ENTERPRISES'), `the destination's own accounts are offered: ${JSON.stringify(u.candidates)}`);
  // The message a person reads says what is missing and what is available.
  assert.match(r.json.error, /Aksh Ent\./);
  assert.match(r.json.error, /AKSH ENTERPRISES/);

  // Nothing was imported, and the transfer is still acceptable once the choice is made.
  const d = db('LIVE', o.destination);
  assert.equal(Number((d.prepare('SELECT COUNT(*) n FROM payments').get() as any).n), 0, 'no payment was imported');
  assert.equal(Number((d.prepare('SELECT COUNT(*) n FROM account_transactions').get() as any).n), 0, 'and no bank posting');
  const list = app.expectOk(await app.call('/api/transfers', { cookie: o.destCookie, method: 'GET' }));
  assert.equal(list.transfers.find((t: any) => t.id === id)?.status, 'PENDING', 'the transfer is not spent');
});

test('a near match is suggested but never applied on its own', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'AKSH ENTERPRISES', bank_name: 'ICICI', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const { id } = await send(o, made.paymentId);

  const r = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: id } });
  assert.equal(r.status, 409, 'the near match did not silently import');
  const u = (r.json.unresolved || []).find((x: any) => x.kind === 'account');
  assert.equal(u.suggestion?.name, 'AKSH ENTERPRISES', 'it is offered as a suggestion');
  assert.equal(Number((db('LIVE', o.destination).prepare('SELECT COUNT(*) n FROM payments').get() as any).n), 0, 'and nothing was posted to it');
});

// ---- 3: the choice resolves it, and the money lands on the chosen account ----------------------

test('supplying the choice imports the records against the chosen account', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'AKSH ENTERPRISES', bank_name: 'ICICI', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const { id } = await send(o, made.paymentId);
  const d = db('LIVE', o.destination);
  const chosen = Number((d.prepare("SELECT id FROM company_accounts WHERE account_name='AKSH ENTERPRISES'").get() as any).id);

  const r = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: id, account_map: { 'Aksh Ent.': chosen } } });
  assert.equal(r.status, 200, `accept with a map: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.status, 'ACCEPTED');

  const imported = d.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 1').get() as any;
  assert.ok(imported, 'the payment was imported');
  assert.equal(Number(imported.company_account_id), chosen, 'against the account the receiver chose');
  assert.equal(Number(imported.amount), 1000, 'for the amount the source recorded');
  const posting = d.prepare('SELECT * FROM account_transactions ORDER BY id DESC LIMIT 1').get() as any;
  if (posting) assert.equal(Number(posting.account_id), chosen, 'and the bank posting follows the same choice');

  // The choice is auditable.
  assert.deepEqual(r.json.receipt.appliedMap?.accounts, { 'aksh ent.': chosen }, 'the receipt records what was mapped');
  const audit = d.prepare("SELECT details FROM audit_logs WHERE action='INTERCOMPANY_TRANSFER_ACCEPTED' ORDER BY id DESC LIMIT 1").get() as any;
  assert.match(String(audit?.details || ''), /appliedMap/, 'and so does the audit log');
});

// ---- 4: a map cannot reach outside the destination organization --------------------------------

test('a map pointing at an account this organization does not hold is refused', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'ICICI Current', bank_name: 'ICICI', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const { id } = await send(o, made.paymentId);

  // The source's own account id is meaningless in the destination; it must not be accepted blindly.
  const r = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: id, account_map: { 'Aksh Ent.': 99999 } } });
  assert.ok(r.status >= 400, `a map to a missing row is refused, got ${r.status}`);
  assert.equal(Number((db('LIVE', o.destination).prepare('SELECT COUNT(*) n FROM payments').get() as any).n), 0, 'and nothing was imported');
});

// ---- 5: an exact name still resolves with no map at all (behaviour preserved) -------------------

test('a destination holding the same account name still accepts with no map, as before', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Shared Bank');
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'Shared Bank', bank_name: 'HDFC', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const { id, created } = await send(o, made.paymentId);
  assert.equal(created.unresolved_links, 0, 'and the sender was told there was nothing outstanding');

  const r = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: id } });
  assert.equal(r.status, 200, `an exact match needs no map: ${r.text.slice(0, 300)}`);
  const imported = db('LIVE', o.destination).prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(Number(imported.amount), 1000);
});

// ---- 6: the sender is told at send time, not left to discover it at acceptance -----------------

test('creating a transfer reports what the destination cannot yet match', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  const { created } = await send(o, made.paymentId);
  assert.equal(created.ok, true, 'the transfer is still created — the receiver may create the record first');
  assert.ok(created.unresolved_links >= 1, `the gap is reported at send time: ${JSON.stringify(created)}`);
  assert.match(created.message, /Aksh Ent\./, 'naming what is missing');
});

// ---- 7: preflight is read-only and answers before acceptance -----------------------------------

test('preflight reports the choices without writing anything', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'ICICI Current', bank_name: 'ICICI', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const { id } = await send(o, made.paymentId);
  const d = db('LIVE', o.destination);
  const before = Number((d.prepare('SELECT COUNT(*) n FROM payments').get() as any).n);

  const r = app.expectOk(await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'preflight', transfer_id: id } }), 'preflight');
  assert.equal(r.can_accept, false, 'it cannot be accepted as it stands');
  assert.ok(r.links_required >= 1);
  assert.ok(r.unresolved.some((u: any) => u.name === 'Aksh Ent.'));
  assert.equal(Number((d.prepare('SELECT COUNT(*) n FROM payments').get() as any).n), before, 'and preflight wrote nothing');

  // With the choice supplied, preflight says it can be accepted — before anything is imported.
  const chosen = Number((d.prepare("SELECT id FROM company_accounts WHERE account_name='ICICI Current'").get() as any).id);
  const ok = app.expectOk(await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'preflight', transfer_id: id, account_map: { 'aksh ent.': chosen } } }));
  assert.equal(ok.can_accept, true, 'the map is honoured regardless of the case it is given in');
  assert.equal(Number((d.prepare('SELECT COUNT(*) n FROM payments').get() as any).n), before, 'still nothing written');
});

// ---- 8: an organization may not preflight or accept another organization's transfer ------------

test('a third organization cannot inspect or accept the transfer', async () => {
  const o = await twoOrgs();
  const made = await postedPayment(o.sourceCookie, o.source, 'Aksh Ent.');
  const { id } = await send(o, made.paymentId);
  const other = await app.adminSession('LIVE');
  for (const action of ['preflight', 'accept']) {
    const r = await app.call('/api/transfers', { cookie: other.cookie, body: { action, transfer_id: id } });
    assert.ok(r.status >= 400, `${action} by an unrelated organization is refused, got ${r.status}`);
    assert.ok(!/candidates/.test(r.text), `${action} leaks no account list to it`);
  }
});

// ---- 9-10: the reported case — a money_in received into an account the destination lacks --------

/** A posted money-in receipt in the source, received into an account with the given name. */
async function postedMoneyIn(cookie: string, companyId: number, accountName: string, bankName: string) {
  const partyName = `Payer ${Math.random().toString(36).slice(2, 7)}`;
  const party = app.expectOk(await app.call('/api/parties', { cookie, body: { name: partyName, contact: '9100000000' } }), 'party');
  app.expectOk(await app.call('/api/accounts', { cookie, body: { account_name: accountName, bank_name: bankName, account_type: 'BANK', opening_balance: 250000, opening_date: '2026-04-01' } }), 'account');
  const accountId = Number((db('LIVE', companyId).prepare('SELECT id FROM company_accounts WHERE account_name=? ORDER BY id DESC LIMIT 1').get(accountName) as any).id);
  const r = app.expectOk(await app.call('/api/money-in', { cookie, body: { party_id: Number(party.id ?? party.partyId), receipt_date: '2026-06-14', amount: 5000, mode: 'NEFT', account_id: accountId } }), 'money in');
  return { partyName, accountId, moneyInId: Number(r.id ?? r.money_in_id ?? r.receipt_id) };
}

test('a money_in whose party exists but whose account does not: only the account is unresolved', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  // The destination already holds the party — the reported situation — but banks elsewhere.
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'VISHVANATH RADHESHYAM RAJPUT KARTA', bank_name: 'KOTAK MAHENDRA BANK LTD', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const created = app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'money_in', ids: [made.moneyInId] } }), 'create money_in');

  const r = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: String(created.transfer_id) } });
  assert.equal(r.status, 409, r.text.slice(0, 200));
  assert.equal(r.json.links_required, 2, 'the party and the account are both links');
  assert.equal(r.json.unresolved.length, 1, `only one is unresolved — the party matched: ${JSON.stringify(r.json.unresolved.map((u: any) => u.name))}`);
  const u = r.json.unresolved[0];
  assert.equal(u.kind, 'account');
  assert.equal(u.name, 'Aksh Ent');
  assert.equal(u.bank_name, 'Union Bank', 'the source bank is carried, so it can be created here');
  assert.equal(u.account_type, 'BANK');
});

test('creating the missing account here, then accepting, imports the receipt', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  await mirrorParty(o, made.partyName);
  const created = app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'money_in', ids: [made.moneyInId] } }));
  const transferId = String(created.transfer_id);
  const need = (await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'preflight', transfer_id: transferId } })).json.unresolved.find((u: any) => u.kind === 'account');

  // What the chooser's "Create … here instead" does: the source's name, bank and type, zero opening.
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: need.name, bank_name: need.bank_name, account_type: need.account_type, opening_balance: 0, opening_date: '2026-11-07' } }), 'create here');
  const after = app.expectOk(await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'preflight', transfer_id: transferId } }));
  assert.equal(after.unresolved.length, 0, `it now resolves by name: ${JSON.stringify(after.unresolved)}`);
  assert.equal(after.can_accept, true);

  const accepted = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: transferId } });
  assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
  const d = db('LIVE', o.destination);
  const account = d.prepare('SELECT * FROM company_accounts WHERE account_name=?').get('Aksh Ent') as any;
  assert.equal(String(account.bank_name), 'Union Bank', 'the account carries the source bank name');
  assert.equal(Number(account.opening_balance), 0, "and its own zero opening balance, not the source's 250000");
  const receipt = d.prepare('SELECT * FROM money_in ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(Number(receipt.amount), 5000, 'the receipt was imported for the amount recorded');
  assert.equal(Number(receipt.account_id), Number(account.id), 'into the account just created');
});

// ---- 11-15: the sender nominates the receiving account at the destination ----------------------

test('a money_in sent with a nominated receiving account imports with no prompt at all', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  await mirrorParty(o, made.partyName);
  // The destination banks elsewhere and has no account of that name — the reported situation.
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'VISHVANATH RADHESHYAM RAJPUT KARTA', bank_name: 'KOTAK MAHENDRA BANK LTD', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const d = db('LIVE', o.destination);
  const receiving = Number((d.prepare("SELECT id FROM company_accounts WHERE account_name='VISHVANATH RADHESHYAM RAJPUT KARTA'").get() as any).id);

  // The sender says where it is received, as a bank transfer names the receiving account.
  const created = app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'money_in', ids: [made.moneyInId], destination_account_id: receiving } }), 'create');
  assert.equal(created.unresolved_links, 0, `nothing left to choose: ${JSON.stringify(created)}`);
  assert.equal(created.receiving_account, 'VISHVANATH RADHESHYAM RAJPUT KARTA', 'and the sender is told where');

  const accepted = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: String(created.transfer_id) } });
  assert.equal(accepted.status, 200, `accepted with no chooser: ${accepted.text.slice(0, 300)}`);
  const receipt = d.prepare('SELECT * FROM money_in ORDER BY id DESC LIMIT 1') .get() as any;
  assert.equal(Number(receipt.amount), 5000, 'the receipt was imported');
  assert.equal(Number(receipt.account_id), receiving, "into the destination's own account");
  const posting = d.prepare('SELECT * FROM account_transactions ORDER BY id DESC LIMIT 1').get() as any;
  if (posting) assert.equal(Number(posting.account_id), receiving, 'and so was its bank posting — the same account, not two');
  assert.deepEqual(accepted.json.receipt.appliedMap?.receivingAccount, { '*': receiving }, 'the nomination is on the receipt');
  const audit = d.prepare("SELECT details FROM audit_logs WHERE action='INTERCOMPANY_TRANSFER_ACCEPTED' ORDER BY id DESC LIMIT 1").get() as any;
  assert.match(String(audit?.details || ''), /receivingAccount/, 'and in the audit log');
});

test('the nomination outranks a same-named account in the destination', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  await mirrorParty(o, made.partyName);
  // The destination has BOTH an identically-named account and the one the sender nominates.
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'Aksh Ent', bank_name: 'Union Bank', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'Kotak Current', bank_name: 'KOTAK', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const d = db('LIVE', o.destination);
  const kotak = Number((d.prepare("SELECT id FROM company_accounts WHERE account_name='Kotak Current'").get() as any).id);

  const created = app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'money_in', ids: [made.moneyInId], destination_account_id: kotak } }));
  assert.equal((await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: String(created.transfer_id) } })).status, 200);
  const receipt = d.prepare('SELECT * FROM money_in ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(Number(receipt.account_id), kotak, 'a deliberate choice beats a coincidental name match');
});

test('the receiver may still override the nomination when accepting', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  await mirrorParty(o, made.partyName);
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'First', bank_name: 'A', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'Second', bank_name: 'B', account_type: 'CASH', opening_balance: 0, opening_date: '2026-04-01' } }));
  const d = db('LIVE', o.destination);
  const first = Number((d.prepare("SELECT id FROM company_accounts WHERE account_name='First'").get() as any).id);
  const second = Number((d.prepare("SELECT id FROM company_accounts WHERE account_name='Second'").get() as any).id);

  const created = app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'money_in', ids: [made.moneyInId], destination_account_id: first } }));
  const accepted = await app.call('/api/transfers', { cookie: o.destCookie, body: { action: 'accept', transfer_id: String(created.transfer_id), account_fields: { '*': second } } });
  assert.equal(accepted.status, 200, accepted.text.slice(0, 200));
  const receipt = d.prepare('SELECT * FROM money_in ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(Number(receipt.account_id), second, "the receiving organization has the last word on its own books");
});

test('a nominated account must exist, be active, and belong to the destination', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  const body = (destination_account_id: any) => ({ action: 'create', destination_company_id: o.destination, type: 'money_in', ids: [made.moneyInId], destination_account_id });
  // The source's own account id means nothing in the destination.
  assert.ok((await app.call('/api/transfers', { cookie: o.sourceCookie, body: body(99999) })).status >= 400, 'a missing account is refused');
  assert.ok((await app.call('/api/transfers', { cookie: o.sourceCookie, body: body(-1) })).status >= 400, 'a negative id is refused');
  // Nothing was created by either refusal.
  assert.equal(app.expectOk(await app.call('/api/transfers', { cookie: o.sourceCookie, method: 'GET' })).transfers.length, 0, 'no transfer was created');
});

test('account_movements links two accounts, so a single nomination is refused', async () => {
  const o = await twoOrgs();
  const made = await postedMoneyIn(o.sourceCookie, o.source, 'Aksh Ent', 'Union Bank');
  app.expectOk(await app.call('/api/accounts', { cookie: o.destCookie, body: { account_name: 'Dest Bank', bank_name: 'A', account_type: 'BANK', opening_balance: 0, opening_date: '2026-04-01' } }));
  const target = Number((db('LIVE', o.destination).prepare("SELECT id FROM company_accounts WHERE account_name='Dest Bank'").get() as any).id);
  const r = await app.call('/api/transfers', { cookie: o.sourceCookie, body: { action: 'create', destination_company_id: o.destination, type: 'account_movements', ids: [made.moneyInId], destination_account_id: target } });
  assert.ok(r.status >= 400, 'refused rather than applying one account to both from and to');
  assert.match(r.json.error, /two accounts|links 2/i, r.json.error);
});

// ---- 16: the sender may only see accounts of a destination it is mapped to ----------------------

test('the destination account list is only served for a mapped destination', async () => {
  const o = await twoOrgs();
  const mine = await app.call('/api/transfers/destinations', { cookie: o.sourceCookie, method: 'GET', query: { accounts_for: String(o.destination) } });
  assert.equal(mine.status, 200, mine.text.slice(0, 200));
  assert.ok(Array.isArray(mine.json.accounts), 'a mapped destination returns its accounts');

  // A user mapped only to the source may not read the destination's accounts. (An ADMIN may: that
  // is the application's existing cross-organization rule, not something this change relaxes.)
  const clerkName = `clerk_${Math.random().toString(36).slice(2, 8)}`;
  await app.seedUser({ username: clerkName, role: 'DATA_ENTRY', companies: [{ id: o.source, live: true }], menu: ['dashboard'] });
  const clerk = await app.login(clerkName, o.source, 'LIVE');
  const theirs = await app.call('/api/transfers/destinations', { cookie: clerk, method: 'GET', query: { accounts_for: String(o.destination) } });
  assert.ok(theirs.status >= 400, `an unmapped destination is refused, got ${theirs.status}: ${theirs.text.slice(0, 200)}`);
  assert.ok(!/account_name/.test(theirs.text), 'and no account names are shown');
});
