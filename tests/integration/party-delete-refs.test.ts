/**
 * v2.8.3 — foreign-key dependency discovery for a blocked party deletion, on real SQLite.
 *
 * The reported failure was `parties · DELETE · id 15` →
 * "FOREIGN_KEY: Referenced tables not discoverable from this table schema."
 * `PRAGMA foreign_key_list(parties)` lists what parties points at (nothing); what blocks a DELETE
 * is the opposite direction. These tests assert the correct direction, the record identifiers, and
 * that a probe failure is never reported as "no dependents".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { referencesTo, describeReferences, describeForeignKeyFailure, softDeleteColumn } from '../../lib/sync-fk';
import { dependentsOf } from '../../lib/sync-delete';

function schema() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_no TEXT, party_id INTEGER NOT NULL REFERENCES parties(id), broker_party_id INTEGER DEFAULT NULL, net_payable REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'POSTED');
    CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id), amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'POSTED');
    CREATE TABLE money_in (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER REFERENCES parties(id), amount REAL NOT NULL DEFAULT 0);
    CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id), debit REAL DEFAULT 0, credit REAL DEFAULT 0);
    CREATE TABLE saudas (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_party_id INTEGER REFERENCES parties(id), selling_party_id INTEGER REFERENCES parties(id));
    CREATE TABLE unrelated (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT);
  `);
  return d;
}

test('every table and record referencing the party is found, in the right direction, with ids', () => {
  const d = schema();
  d.prepare("INSERT INTO parties(id,name) VALUES(15,'Blocked Vendor')").run();
  d.prepare("INSERT INTO parties(id,name) VALUES(16,'Other Vendor')").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,net_payable) VALUES(101,'P-1',15,50000)").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,net_payable) VALUES(102,'P-2',15,25000)").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,net_payable) VALUES(103,'P-3',16,10000)").run();
  d.prepare('INSERT INTO payments(id,party_id,amount) VALUES(201,15,30000)').run();
  d.prepare('INSERT INTO money_in(id,party_id,amount) VALUES(301,15,5000)').run();
  d.prepare('INSERT INTO ledger(id,party_id,credit) VALUES(401,15,50000)').run();
  d.prepare('INSERT INTO saudas(id,purchase_party_id,selling_party_id) VALUES(501,15,16)').run();

  const refs = referencesTo(d, 'parties', { id: 15 });
  const byTable = Object.fromEntries(refs.map((r) => [`${r.table}.${r.column}`, r]));
  assert.equal(byTable['purchases.party_id'].count, 2);
  assert.deepEqual(byTable['purchases.party_id'].ids, [101, 102]);
  assert.equal(byTable['payments.party_id'].count, 1);
  assert.deepEqual(byTable['payments.party_id'].ids, [201]);
  assert.equal(byTable['money_in.party_id'].count, 1);
  assert.equal(byTable['ledger.party_id'].count, 1);
  assert.equal(byTable['saudas.purchase_party_id'].count, 1, 'both party columns of saudas are checked');
  assert.equal(byTable['saudas.selling_party_id'], undefined, 'the other party column does not reference 15');
  assert.ok(!refs.some((r) => r.table === 'unrelated'), 'a table with no reference is not reported');
  assert.ok(!refs.some((r) => r.table === 'purchases' && r.ids.includes(103)), 'another party\'s records are not reported');

  // The message names the tables and the record ids — the detail the old error lacked entirely.
  const message = describeReferences(refs).join('; ');
  assert.match(message, /2 purchases via party_id \(101, 102\)/);
  assert.match(message, /1 payments via party_id \(201\)/);
  assert.match(message, /ledger/);
});

test('a conventional reference with no foreign key is reported as dangling, not hidden', () => {
  const d = schema();
  d.prepare("INSERT INTO parties(id,name) VALUES(15,'Broker')").run();
  d.prepare("INSERT INTO parties(id,name) VALUES(16,'Vendor')").run();
  // broker_party_id has no FK in the schema: SQLite will not block the delete, but the row would
  // be left pointing at a party that no longer exists.
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,broker_party_id,net_payable) VALUES(104,'P-4',16,15,40000)").run();
  const refs = referencesTo(d, 'parties', { id: 15 });
  const soft = refs.find((r) => r.column === 'broker_party_id');
  assert.ok(soft, 'the undeclared reference is found');
  assert.equal(soft!.declared, false);
  assert.deepEqual(soft!.ids, [104]);
  assert.match(describeReferences(refs).join('; '), /no foreign key: would be left dangling/);
  assert.equal(referencesTo(d, 'parties', { id: 15 }, { includeUndeclared: false }).length, 0, 'declared-only mode excludes it');
});

test('the DELETE diagnostic names the blocking tables instead of "not discoverable"', () => {
  const d = schema();
  d.prepare("INSERT INTO parties(id,name) VALUES(15,'Blocked Vendor')").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,net_payable) VALUES(101,'P-1',15,50000)").run();
  let error: any = null;
  try { d.prepare('DELETE FROM parties WHERE id=15').run(); } catch (e) { error = e; }
  assert.ok(error, 'SQLite refuses the delete');
  const event = { table_name: 'parties', pk_json: JSON.stringify({ id: 15 }), operation: 'DELETE' };
  const described = describeForeignKeyFailure(d, event, error);
  assert.ok(!/not discoverable from this table schema/.test(described), `the old unusable message is gone: ${described}`);
  assert.match(described, /Cannot delete parties/);
  assert.match(described, /1 purchases via party_id \(101\)/);
  assert.match(described, /deactivate this record instead|retryable/);

  // An INSERT still reports the parents it depends on, as before.
  const insert = describeForeignKeyFailure(d, { table_name: 'purchases', pk_json: '{"id":9}', operation: 'INSERT' }, error);
  assert.match(insert, /depends on parties\.id via party_id/);
});

test('a probe that fails is reported as blocking, never as "no dependents"', () => {
  const d = schema();
  d.prepare("INSERT INTO parties(id,name) VALUES(15,'Vendor')").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,net_payable) VALUES(101,'P-1',15,1)").run();
  // A table whose foreign key points at parties but which cannot be queried (a view replacing the
  // table is the realistic case). The previous implementation swallowed the error and returned no
  // dependents, which is how a blocked deletion reached SQLite and failed opaquely.
  const original = d.prepare.bind(d);
  (d as any).prepare = (sql: string) => {
    if (/SELECT COUNT\(\*\) n FROM "purchases"/.test(sql)) throw new Error('no such column');
    return original(sql);
  };
  const refs = referencesTo(d, 'parties', { id: 15 });
  const blocked = refs.find((r) => r.table === 'purchases');
  assert.ok(blocked, 'the table is still reported');
  assert.equal(blocked!.count, -1, 'with an unknown count rather than zero');
  assert.match(describeReferences(refs).join(''), /an unknown number of purchases/);
});

test('dependentsOf carries the same facts for the existing resolution flow', () => {
  const d = schema();
  d.prepare("INSERT INTO parties(id,name) VALUES(15,'Vendor')").run();
  d.prepare("INSERT INTO purchases(id,sample_no,party_id,net_payable) VALUES(101,'P-1',15,1)").run();
  d.prepare('INSERT INTO ledger(id,party_id,debit) VALUES(401,15,1)').run();
  const deps = dependentsOf(d, 'parties', { id: 15 });
  assert.deepEqual(deps.map((x) => x.table).sort(), ['ledger', 'purchases']);
  assert.deepEqual(deps.find((x) => x.table === 'purchases')!.ids, [101]);
  assert.equal(dependentsOf(d, 'parties', { id: 999 }).length, 0, 'a record nothing references has no dependents');
});

test('a party is deactivatable, a financial table is not', () => {
  const d = schema();
  assert.equal(softDeleteColumn(d, 'parties'), 'active');
  assert.equal(softDeleteColumn(d, 'purchases'), null);
  assert.equal(softDeleteColumn(d, 'ledger'), null);
});
