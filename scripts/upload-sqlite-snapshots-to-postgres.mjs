import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Client } = pg;
const root = process.env.FINANCE_DATA_DIR?.trim()
  ? path.resolve(process.env.FINANCE_DATA_DIR.trim())
  : path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'), 'SOLIVY-FINANCE', 'data');
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is required. Set it to the target PostgreSQL/Neon database before running this importer.');
  process.exit(1);
}

const snapshots = [];
const adminPath = path.join(root, 'admin.db');
if (fs.existsSync(adminPath)) {
  snapshots.push({ key: 'admin', file: adminPath });
  let ids = [1];
  const d = new Database(adminPath, { readonly: true, fileMustExist: true });
  try {
    const exists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'").get();
    if (exists) ids = [...new Set([1, ...d.prepare('SELECT id FROM companies').all().map(x => Number(x.id)).filter(x => Number.isInteger(x) && x > 0)])];
  } finally { d.close(); }
  for (const id of ids) {
    for (const mode of ['LIVE', 'TEST']) {
      const file = id === 1
        ? path.join(root, mode === 'LIVE' ? 'live.db' : 'test.db')
        : path.join(root, 'companies', String(id), mode === 'LIVE' ? 'live.db' : 'test.db');
      if (fs.existsSync(file)) snapshots.push({ key: `company:${id}:${mode}`, file });
    }
  }
} else {
  for (const mode of ['LIVE', 'TEST']) {
    const file = path.join(root, mode === 'LIVE' ? 'live.db' : 'test.db');
    if (fs.existsSync(file)) snapshots.push({ key: `company:1:${mode}`, file });
  }
}
if (!snapshots.length) {
  console.error(`No SOLIVY SQLite database files found under ${root}`);
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [530202530]);
  await client.query(`CREATE TABLE IF NOT EXISTS solivy_sqlite_snapshots (
    db_key TEXT PRIMARY KEY,
    db_file BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // v2.7.0+: snapshots are versioned and chunked. A raw db_file overwrite would be ignored by running
  // instances (version unchanged) and would bypass the pre-replacement backup, so refuse here.
  const v27 = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name='solivy_sqlite_snapshots' AND column_name='manifest'`);
  if (v27.rowCount) {
    console.error('This database uses the v2.7 chunked snapshot format. Use: npm run snapshot:online -- import <db_key> <file.db> --confirm');
    process.exit(2);
  }
  console.log(`Found ${snapshots.length} SQLite database file(s).`);
  for (const item of snapshots) {
    const bytes = fs.readFileSync(item.file);
    await client.query(
      `INSERT INTO solivy_sqlite_snapshots(db_key, db_file, updated_at) VALUES($1, $2, NOW())
       ON CONFLICT(db_key) DO UPDATE SET db_file = EXCLUDED.db_file, updated_at = NOW()`,
      [item.key, bytes],
    );
    console.log(`Uploaded ${item.key} (${bytes.length} bytes)`);
  }
  console.log('Upload complete. Back up the target PostgreSQL database before running this script again, because matching snapshots are replaced.');
} catch (error) {
  console.error('Snapshot upload failed:', error?.message || error);
  process.exitCode = 1;
} finally {
  try { await client.query('SELECT pg_advisory_unlock($1)', [530202530]); } catch {}
  await client.end().catch(() => {});
}
