import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { db, adminDb, closeAllDatabases, databasePath, adminDatabasePath, SCHEMA_VERSION, appDataDirectory } from '../../lib/db';

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('opening an unchanged company database is read-only (bytes identical)', () => {
  const d = db('LIVE', 42);
  d.prepare("INSERT INTO parties(name) VALUES('X')").run();
  closeAllDatabases();
  const file = databasePath('LIVE', 42);
  const before = sha(file);
  for (let i = 0; i < 3; i++) { db('LIVE', 42).prepare('SELECT COUNT(*) FROM parties').get(); closeAllDatabases(); }
  assert.equal(sha(file), before);
  const v = new Database(file); assert.equal(v.pragma('user_version', { simple: true }), SCHEMA_VERSION); v.close();
});

test('adminDb() does not open company 1 and is byte-stable on reopen', () => {
  adminDb(); closeAllDatabases();
  assert.equal(fs.existsSync(databasePath('LIVE', 1)), false, 'company 1 LIVE must not be created by adminDb()');
  const before = sha(adminDatabasePath());
  adminDb().prepare('SELECT COUNT(*) FROM companies').get(); closeAllDatabases();
  assert.equal(sha(adminDatabasePath()), before);
});

test('legacy database (user_version 0) is backed up before migration and migration is logged', () => {
  const file = databasePath('LIVE', 77);
  // Simulate a v2.6.30 database: full schema, real data, user_version 0, no migrations table.
  db('LIVE', 77).prepare("INSERT INTO parties(name) VALUES('Legacy Vendor')").run();
  closeAllDatabases();
  const legacy = new Database(file); legacy.exec('DROP TABLE schema_migrations'); legacy.pragma('user_version = 0'); legacy.close();
  const d = db('LIVE', 77);
  const m = d.prepare('SELECT * FROM schema_migrations').all() as any[];
  assert.equal(m.length, 1);
  assert.equal(m[0].version, SCHEMA_VERSION);
  closeAllDatabases();
  const backups = fs.readdirSync(path.join(path.dirname(file), 'pre-migration-backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], new RegExp(`live-v0-to-v${SCHEMA_VERSION}`));
  assert.ok(appDataDirectory());
});

test('runtime ALTER TABLE causes sync triggers to be rebuilt on next open (new column captured)', () => {
  const d = db('LIVE', 43);
  d.exec("ALTER TABLE parties ADD COLUMN zz_extra TEXT DEFAULT ''");
  closeAllDatabases();
  const d2 = db('LIVE', 43);
  d2.prepare("INSERT INTO parties(name,zz_extra) VALUES('Y','captured')").run();
  const ev = d2.prepare("SELECT row_json FROM sync_changes WHERE table_name='parties' ORDER BY seq DESC LIMIT 1").get() as any;
  assert.match(ev.row_json, /captured/);
  closeAllDatabases();
});
