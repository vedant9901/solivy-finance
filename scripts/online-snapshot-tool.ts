/**
 * Online (PostgreSQL/Neon) snapshot administration — backup, restore and rollback.
 *   npx tsx scripts/online-snapshot-tool.ts list
 *   npx tsx scripts/online-snapshot-tool.ts export <db_key> <out.db>
 *   npx tsx scripts/online-snapshot-tool.ts import <db_key> <file.db> --confirm      (current version is backed up first)
 *   npx tsx scripts/online-snapshot-tool.ts backups [db_key]
 *   npx tsx scripts/online-snapshot-tool.ts restore-backup <backup_id> --confirm      (current version is backed up first)
 * db_key: admin | company:<id>:LIVE | company:<id>:TEST. Requires DATABASE_URL. Stop traffic (or accept a 409 retry
 * for in-flight requests) before import/restore: the write is version-checked and atomic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { ensureTables, materialize, writeSnapshot, backupSnapshot, sha256, manifestOf, decodeBlob, SNAPSHOT_TABLE, BACKUP_TABLE } from '../lib/snapshot-store';

const KEY = /^(admin|company:\d+:(LIVE|TEST))$/;
function sslFor(cs: string) { if (process.env.SOLIVY_PG_SSL === 'disable' && ['127.0.0.1', 'localhost', '::1'].includes(new URL(cs).hostname)) return false; return { rejectUnauthorized: true }; }

export async function run(argv: string[], log: (s: string) => void = console.log) {
  const cs = process.env.DATABASE_URL; if (!cs) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: cs, ssl: sslFor(cs) as any, max: 2 });
  const client = await pool.connect();
  const [cmd, a, b] = argv; const confirm = argv.includes('--confirm');
  try {
    await ensureTables(client);
    const current = async (key: string) => {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-snap-')), 'x.db');
      const got = (await materialize(client, [{ key, file: tmp }])).get(key);
      return got ? { copy: got, bytes: fs.readFileSync(tmp) } : null;
    };
    const lock = (key: string) => client.query('SELECT pg_advisory_lock($1, hashtext($2))', [530202530, key]);
    if (cmd === 'list') {
      const r = await client.query(`SELECT db_key, version::text v, format, size_bytes, updated_at FROM ${SNAPSHOT_TABLE} ORDER BY db_key`);
      for (const x of r.rows) log(`${x.db_key}\tv${x.v}\tformat ${x.format}\t${x.size_bytes ?? '?'} bytes\t${new Date(x.updated_at).toISOString()}`);
      return r.rows;
    }
    if (cmd === 'export') {
      if (!KEY.test(a || '') || !b) throw new Error('usage: export <db_key> <out.db>');
      const c = await current(a); if (!c) throw new Error(`No snapshot for ${a}.`);
      fs.writeFileSync(b, c.bytes); log(`Exported ${a} v${c.copy.version} (${c.bytes.length} bytes, sha256 ${c.copy.sha.slice(0, 12)}) to ${b}`);
      return c.copy;
    }
    if (cmd === 'backups') {
      const r = await client.query(`SELECT id, db_key, reason, octet_length(db_file) bytes, created_at FROM ${BACKUP_TABLE} ${a ? 'WHERE db_key=$1' : ''} ORDER BY id DESC LIMIT 100`, a ? [a] : []);
      for (const x of r.rows) log(`#${x.id}\t${x.db_key}\t${x.reason}\t${x.bytes} bytes (compressed)\t${new Date(x.created_at).toISOString()}`);
      return r.rows;
    }
    if (cmd === 'import' || cmd === 'restore-backup') {
      let key = a, bytes: Buffer;
      if (cmd === 'import') {
        if (!KEY.test(a || '') || !b || !fs.existsSync(b)) throw new Error('usage: import <db_key> <file.db> --confirm');
        bytes = fs.readFileSync(b);
      } else {
        const r = await client.query(`SELECT db_key, encode(db_file,'base64') b64 FROM ${BACKUP_TABLE} WHERE id=$1`, [Number(a)]);
        if (!r.rows[0]) throw new Error(`Backup #${a} not found.`);
        key = r.rows[0].db_key; bytes = decodeBlob(Buffer.from(r.rows[0].b64.replace(/\s+/g, ''), 'base64'));
      }
      if (bytes.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('Not a SQLite database file.');
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-chk-')), 'c.db'); fs.writeFileSync(tmp, bytes);
      const chk = new Database(tmp, { readonly: true }); const ok = chk.pragma('integrity_check', { simple: true }); chk.close();
      if (ok !== 'ok') throw new Error(`Integrity check failed: ${ok}`);
      if (!confirm) { log(`DRY RUN: would replace ${key} with ${bytes.length} bytes (sha256 ${sha256(bytes).slice(0, 12)}, ${manifestOf(bytes).length} chunks). Re-run with --confirm.`); return { dryRun: true, key }; }
      await lock(key);
      const cur = await current(key);
      await client.query('BEGIN');
      try {
        if (cur) await backupSnapshot(client, key, cur.bytes, `before ${cmd} ${new Date().toISOString()}`);
        const next = await writeSnapshot(client, key, bytes, cur ? cur.copy : null);
        if (!next) throw new Error('Version changed during restore; nothing was written. Retry.');
        await client.query('COMMIT');
        log(`Restored ${key} → v${next.version}. Previous version saved in ${BACKUP_TABLE}.`);
        return next;
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
    throw new Error('Commands: list | export | import | backups | restore-backup');
  } finally { client.release(); await pool.end(); }
}

if (require.main === module) run(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
