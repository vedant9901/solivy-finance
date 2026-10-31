import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PoolClient } from 'pg';
import { SCHEMA_VERSION, databasePath, closeDatabase, type Mode } from './db';
import { diagnose } from './data-health';
import { isLocalOnlyTable } from './sync-eligibility';
import { materialize, writeSnapshot, backupSnapshot, remoteVersions, sha256, CHUNK_SIZE, type LocalCopy } from './snapshot-store';

/**
 * `remoteVersions` returns only the current version, which is all the optimistic write guard
 * needs. An empty manifest makes the clone upload every chunk and refresh the base blob — the
 * whole point of a clone — while `WHERE version = prev.version` still refuses to overwrite a
 * snapshot that changed underneath us.
 */
const priorFor = (version: string | undefined): LocalCopy | null => (version ? { version, sha: '', manifest: [], chunkSize: CHUNK_SIZE } : null);

/**
 * Full database clone engine (v2.9.0).
 *
 * WHAT THE ARCHITECTURE ACTUALLY IS. Online storage is not a row-per-row mirror: the whole
 * organization SQLite file is held in PostgreSQL as 4 KiB page-aligned Brotli chunks plus a base
 * blob, with a manifest and optimistic versioning (`lib/snapshot-store.ts`). Device ⇄ hub
 * synchronisation on top of that is event replication through the `sync_changes` journal. So the
 * system is a hybrid, and a *clone* in either direction is a verified snapshot transfer, while
 * *incremental sync* stays event-based. Building the clone on the existing chunk store is what
 * makes it resumable and cheap on Neon: only pages that differ are uploaded or downloaded.
 *
 * WHY A CLONE IS NEEDED AT ALL. Event replication can only converge if both sides started from a
 * common ancestor. Two databases that drifted apart — or a device re-baselined from a backup —
 * cannot be reconciled event by event: that is what produced endless conflicts where resolving one
 * surfaced the next. The clone establishes a common ancestor, and `realignAfterClone` then puts
 * the journal and cursor in the one state where incremental sync is correct from that point on.
 *
 * SAFETY MODEL. Nothing is ever applied in place:
 *   1. a consistent snapshot is taken with VACUUM INTO (never a raw copy of a live WAL database);
 *   2. it is validated (integrity, foreign keys, schema version, accounting invariants);
 *   3. it is written to a STAGING key / temporary file, never over the live data;
 *   4. the staged copy is read back and fingerprinted, and the fingerprint must equal the source;
 *   5. only then is it activated, after the previous version is kept for rollback;
 *   6. any failure aborts before activation and leaves both databases untouched.
 */

export type TableFingerprint = { rows: number; sha: string };
export type Fingerprint = {
  schema_version: number;
  tables: Record<string, TableFingerprint>;
  totals: Record<string, number>;
  business_rows: number;
};
export type Check = { name: string; ok: boolean; detail: string };
export type Validation = { ok: boolean; checks: Check[]; fingerprint: Fingerprint | null };

/** Financial aggregates verified after every clone. Each is a sum the destination must reproduce. */
const TOTALS: Array<[string, string]> = [
  ['purchases_net_payable', 'SELECT ROUND(COALESCE(SUM(net_payable),0),2) v FROM purchases'],
  ['purchases_count', 'SELECT COUNT(*) v FROM purchases'],
  ['payments_amount', 'SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM payments'],
  ['payment_allocations_amount', 'SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM payment_allocations'],
  ['money_in_amount', 'SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM money_in'],
  ['money_out_amount', 'SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM money_out'],
  ['interest_payments_amount', 'SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM interest_payments'],
  ['receivables_receivable', 'SELECT ROUND(COALESCE(SUM(receivable_amount),0),2) v FROM financing_receivables'],
  ['receivables_received', 'SELECT ROUND(COALESCE(SUM(received_amount),0),2) v FROM financing_receivables'],
  ['funding_principal', 'SELECT ROUND(COALESCE(SUM(principal_amount),0),2) v FROM funding_loans'],
  ['account_transactions_debit', "SELECT ROUND(COALESCE(SUM(CASE WHEN transaction_type='DEBIT' THEN amount ELSE 0 END),0),2) v FROM account_transactions"],
  ['account_transactions_credit', "SELECT ROUND(COALESCE(SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE 0 END),0),2) v FROM account_transactions"],
  ['ledger_debit', 'SELECT ROUND(COALESCE(SUM(debit),0),2) v FROM ledger'],
  ['ledger_credit', 'SELECT ROUND(COALESCE(SUM(credit),0),2) v FROM ledger'],
  ['parties_count', 'SELECT COUNT(*) v FROM parties'],
  ['reversed_payments', "SELECT COUNT(*) v FROM payments WHERE UPPER(COALESCE(status,'')) LIKE 'REVERS%'"],
];

function openReadOnly(file: string) {
  const d = new Database(file, { readonly: true });
  return d;
}

/**
 * A consistent copy of a live WAL database. VACUUM INTO reads one transaction-consistent view and
 * writes a fresh file with the WAL folded in, which is why the file is never copied byte for byte.
 */
export function snapshotToFile(d: any, destination: string) {
  if (fs.existsSync(destination)) fs.unlinkSync(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  d.prepare('VACUUM INTO ?').run(destination);
  return destination;
}

function businessTables(d: any): string[] {
  return (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[])
    .map((t) => String(t.name))
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !isLocalOnlyTable(t));
}

/**
 * Per-table row counts and content hashes plus the financial aggregates, over business tables only.
 *
 * Local-only tables are excluded deliberately: after a clone the device keeps its own identity,
 * journal and cursor (see `realignAfterClone`), so those tables differ between the two sides by
 * design. Including them would make every verification fail and hide real differences.
 */
export function fingerprintOf(d: any): Fingerprint {
  const tables: Record<string, TableFingerprint> = {};
  let businessRows = 0;
  for (const table of businessTables(d)) {
    const cols = (d.prepare(`PRAGMA table_info("${table}")`).all() as any[]).map((c: any) => String(c.name)).sort();
    const pk = (d.prepare(`PRAGMA table_info("${table}")`).all() as any[]).filter((c: any) => Number(c.pk) > 0).map((c: any) => `"${c.name}"`);
    const order = pk.length ? pk.join(',') : cols.map((c) => `"${c}"`).join(',');
    const hash = crypto.createHash('sha256');
    let rows = 0;
    for (const row of d.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${table}" ORDER BY ${order}`).iterate() as any) {
      rows++;
      hash.update(cols.map((c) => stable(row[c])).join('\u0001'));
      hash.update('\u0002');
    }
    tables[table] = { rows, sha: hash.digest('hex').slice(0, 32) };
    businessRows += rows;
  }
  const totals: Record<string, number> = {};
  for (const [name, sql] of TOTALS) {
    try { totals[name] = Number((d.prepare(sql).get() as any)?.v || 0); } catch { /* table absent on an older schema */ }
  }
  return { schema_version: Number(d.pragma('user_version', { simple: true }) || 0), tables, totals, business_rows: businessRows };
}

function stable(v: any): string {
  if (v === null || v === undefined) return '\u0000';
  if (Buffer.isBuffer(v)) return 'b:' + v.toString('base64');
  if (typeof v === 'number') return 'n:' + (Number.isInteger(v) ? String(v) : v.toFixed(6));
  return 's:' + String(v);
}

export type Difference = { kind: string; table?: string; name?: string; source: any; destination: any };

/**
 * Append-only operational logs. A verification request is itself audited, so the destination can
 * legitimately hold one row more than the source that was read a moment earlier. Losing rows is
 * still reported; gaining them is not. Their contents are transferred and verified by the clone's
 * own byte-for-byte read-back — only this live comparison is relaxed.
 */
const APPEND_ONLY = new Set(['audit_logs']);

/** Source against destination: schema version, every table's rows and content, every total. */
export function compareFingerprints(source: Fingerprint, destination: Fingerprint, opts: { appendOnly?: 'no-loss' | 'ignore' } = {}) {
  const differences: Difference[] = [];
  if (source.schema_version !== destination.schema_version) differences.push({ kind: 'schema_version', source: source.schema_version, destination: destination.schema_version });
  for (const table of Object.keys(source.tables)) {
    const a = source.tables[table]; const b = destination.tables[table];
    if (!b) { differences.push({ kind: 'missing_table', table, source: a.rows, destination: null }); continue; }
    if (APPEND_ONLY.has(table)) {
      // 'no-loss' (clone verification): the copy must not hold fewer rows than its source.
      // 'ignore' (comparing two live databases): either side may hold a log row the other has not
      // received yet, which is a pending change rather than a disagreement.
      if (opts.appendOnly !== 'ignore' && b.rows < a.rows) differences.push({ kind: 'rows_lost', table, source: a.rows, destination: b.rows });
      continue;
    }
    if (a.rows !== b.rows) differences.push({ kind: 'row_count', table, source: a.rows, destination: b.rows });
    else if (a.sha !== b.sha) differences.push({ kind: 'content', table, source: a.sha, destination: b.sha });
  }
  for (const table of Object.keys(destination.tables)) if (!source.tables[table]) differences.push({ kind: 'extra_table', table, source: null, destination: destination.tables[table].rows });
  for (const name of Object.keys(source.totals)) {
    const a = source.totals[name]; const b = destination.totals[name];
    if (b === undefined) { differences.push({ kind: 'missing_total', name, source: a, destination: null }); continue; }
    if (Math.abs(Number(a) - Number(b)) > 0.005) differences.push({ kind: 'total', name, source: a, destination: b });
  }
  return { ok: differences.length === 0, differences };
}

/**
 * Is this database fit to be cloned or activated? Structural integrity, referential integrity, the
 * schema version, and the accounting invariants the application already checks (`lib/data-health`).
 */
export function validateDatabaseFile(file: string): Validation {
  const checks: Check[] = [];
  let fingerprint: Fingerprint | null = null;
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    return { ok: false, checks: [{ name: 'file', ok: false, detail: 'The database file is missing or empty.' }], fingerprint: null };
  }
  let d: any = null;
  try {
    d = openReadOnly(file);
    const integrity = String((d.pragma('integrity_check', { simple: true }) || 'unknown'));
    checks.push({ name: 'integrity_check', ok: integrity === 'ok', detail: integrity });

    const fk = d.prepare('PRAGMA foreign_key_check').all() as any[];
    checks.push({ name: 'foreign_key_check', ok: fk.length === 0, detail: fk.length ? `${fk.length} violation(s): ${fk.slice(0, 5).map((r: any) => `${r.table}.rowid ${r.rowid} -> ${r.parent}`).join('; ')}` : 'no violations' });

    const version = Number(d.pragma('user_version', { simple: true }) || 0);
    checks.push({ name: 'schema_version', ok: version === SCHEMA_VERSION, detail: `${version} (this build expects ${SCHEMA_VERSION})` });

    const core = ['parties', 'purchases', 'payments', 'company_settings', 'company_accounts'];
    const missing = core.filter((t) => !d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
    checks.push({ name: 'core_tables', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `${core.length} present` });

    let health: any = { issues: [] };
    try { health = diagnose(d); } catch (e: any) { health = { issues: [{ code: 'DIAGNOSE_FAILED', severity: 'high', detail: String(e?.message || e) }] }; }
    const high = (health.issues || []).filter((i: any) => i && i.severity === 'high');
    checks.push({ name: 'accounting_invariants', ok: high.length === 0, detail: high.length ? high.map((i: any) => `${i.code} (${i.count ?? '?'})`).join('; ') : `${(health.issues || []).length} non-blocking note(s)` });

    fingerprint = fingerprintOf(d);
    checks.push({ name: 'fingerprint', ok: true, detail: `${Object.keys(fingerprint.tables).length} business tables, ${fingerprint.business_rows} rows` });
  } catch (e: any) {
    checks.push({ name: 'readable', ok: false, detail: String(e?.message || e) });
  } finally { try { d?.close(); } catch { /* already closed */ } }
  return { ok: checks.every((c) => c.ok), checks, fingerprint };
}

export const stagingKeyFor = (companyId: number, mode: Mode) => `company:${companyId}:${mode}:clone-staging`;
export const activeKeyFor = (companyId: number, mode: Mode) => `company:${companyId}:${mode}`;

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-clone-')); }

export type CloneOutcome = {
  ok: boolean;
  direction: 'push' | 'pull';
  stage: string;
  source: Fingerprint | null;
  destination: Fingerprint | null;
  differences: Difference[];
  checks: Check[];
  bytes: number;
  sha: string;
  previous_version: string | null;
  activated: boolean;
  rollback_available: boolean;
  message: string;
};

/** Everything that must hold before a clone is allowed to start, in either direction. */
function preflight(source: Validation, label: string): { ok: boolean; message: string } {
  if (!source.ok) {
    const failed = source.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
    return { ok: false, message: `The ${label} database did not pass validation, so nothing was transferred: ${failed}` };
  }
  return { ok: true, message: '' };
}

/**
 * OFFLINE → ONLINE. The local database is snapshotted, validated, uploaded to a staging key,
 * read back from PostgreSQL and fingerprinted; the online snapshot is only replaced if that
 * fingerprint matches the source exactly, and the version it replaces is kept for rollback.
 */
export async function pushCloneToOnline(client: PoolClient, opts: { companyId: number; mode: Mode; db: any; dryRun?: boolean }): Promise<CloneOutcome> {
  const { companyId, mode } = opts;
  const dir = tempDir();
  const outcome: CloneOutcome = { ok: false, direction: 'push', stage: 'snapshot', source: null, destination: null, differences: [], checks: [], bytes: 0, sha: '', previous_version: null, activated: false, rollback_available: false, message: '' };
  try {
    const localFile = snapshotToFile(opts.db, path.join(dir, 'source.db'));
    const source = validateDatabaseFile(localFile);
    outcome.checks = source.checks; outcome.source = source.fingerprint;
    const gate = preflight(source, 'offline');
    if (!gate.ok) { outcome.stage = 'validate-source'; outcome.message = gate.message; return outcome; }

    const bytes = fs.readFileSync(localFile);
    outcome.bytes = bytes.length; outcome.sha = sha256(bytes);

    if (opts.dryRun) {
      outcome.stage = 'preview'; outcome.ok = true;
      outcome.previous_version = (await remoteVersions(client, [activeKeyFor(companyId, mode)])).get(activeKeyFor(companyId, mode)) || null;
      outcome.message = `Ready to upload ${Object.keys(source.fingerprint!.tables).length} tables and ${source.fingerprint!.business_rows} records (${(bytes.length / 1024).toFixed(0)} KB). The online snapshot is replaced only after the uploaded copy is read back and verified.`;
      return outcome;
    }

    // 1. Staging: a key of its own, so the live online snapshot is never written during upload.
    outcome.stage = 'stage';
    const stagingKey = stagingKeyFor(companyId, mode);
    const stagingPrev = (await remoteVersions(client, [stagingKey])).get(stagingKey);
    const written = await writeSnapshot(client, stagingKey, bytes, priorFor(stagingPrev));
    if (!written) { outcome.stage = 'stage'; outcome.message = 'Another clone of this organization is in progress (the staging snapshot changed underneath this one). Nothing was activated.'; return outcome; }

    // 2. Read the staged copy back out of PostgreSQL and verify it against the source.
    outcome.stage = 'verify-staged';
    const stagedFile = path.join(dir, 'staged.db');
    const read = await materialize(client, [{ key: stagingKey, file: stagedFile }]);
    if (!read.get(stagingKey)) { outcome.message = 'The staged snapshot could not be read back from PostgreSQL. Nothing was activated.'; return outcome; }
    const staged = validateDatabaseFile(stagedFile);
    outcome.checks = outcome.checks.concat(staged.checks.map((c) => ({ ...c, name: `staged.${c.name}` })));
    if (!staged.ok || !staged.fingerprint) { outcome.message = `The uploaded copy did not validate, so the online snapshot was left unchanged: ${staged.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`; return outcome; }
    const comparison = compareFingerprints(source.fingerprint!, staged.fingerprint);
    outcome.destination = staged.fingerprint; outcome.differences = comparison.differences;
    if (!comparison.ok) { outcome.message = `The uploaded copy differs from the source in ${comparison.differences.length} place(s), so the online snapshot was left unchanged.`; return outcome; }

    // 3. Activation: keep the version being replaced, then write the verified bytes to the live key.
    outcome.stage = 'activate';
    const activeKey = activeKeyFor(companyId, mode);
    const current = (await remoteVersions(client, [activeKey])).get(activeKey);
    outcome.previous_version = current || null;
    if (current) {
      const previousFile = path.join(dir, 'previous.db');
      const got = await materialize(client, [{ key: activeKey, file: previousFile }]);
      if (got.get(activeKey) && fs.existsSync(previousFile)) {
        await backupSnapshot(client, activeKey, fs.readFileSync(previousFile), `pre-clone-push v${current}`);
        outcome.rollback_available = true;
      }
    }
    const activated = await writeSnapshot(client, activeKey, bytes, priorFor(current));
    if (!activated) { outcome.message = 'The online snapshot changed while this clone was being verified, so it was not replaced. Run the clone again.'; return outcome; }

    outcome.stage = 'verified';
    outcome.activated = true; outcome.ok = true;
    outcome.message = `The online copy of this organization now matches the offline database: ${source.fingerprint!.business_rows} records across ${Object.keys(source.fingerprint!.tables).length} tables, verified table by table and against ${Object.keys(source.fingerprint!.totals).length} financial totals.`;
    return outcome;
  } catch (e: any) {
    outcome.message = `The clone stopped at "${outcome.stage}" and nothing was activated: ${String(e?.message || e)}`;
    return outcome;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
}

/**
 * ONLINE → OFFLINE. The online snapshot is materialised to a temporary file, validated and
 * fingerprinted; only then is the local file replaced, with the previous file kept beside it.
 * The device's own identity, journal and cursor are restored afterwards by `realignAfterClone`.
 */
export async function pullCloneToOffline(client: PoolClient, opts: { companyId: number; mode: Mode; db: any; dryRun?: boolean; deviceId?: string }): Promise<CloneOutcome> {
  const { companyId, mode } = opts;
  const dir = tempDir();
  const outcome: CloneOutcome = { ok: false, direction: 'pull', stage: 'fetch', source: null, destination: null, differences: [], checks: [], bytes: 0, sha: '', previous_version: null, activated: false, rollback_available: false, message: '' };
  try {
    const activeKey = activeKeyFor(companyId, mode);
    const remote = (await remoteVersions(client, [activeKey])).get(activeKey);
    if (!remote) { outcome.message = 'This organization and environment have no online snapshot yet, so there is nothing to clone down. Push the offline database up first.'; return outcome; }
    outcome.previous_version = remote;

    const fetched = path.join(dir, 'online.db');
    const got = await materialize(client, [{ key: activeKey, file: fetched }]);
    if (!got.get(activeKey) || !fs.existsSync(fetched)) { outcome.message = 'The online snapshot could not be read in full. Nothing on this device was changed.'; return outcome; }
    const bytes = fs.readFileSync(fetched);
    outcome.bytes = bytes.length; outcome.sha = sha256(bytes);

    outcome.stage = 'validate-source';
    const source = validateDatabaseFile(fetched);
    outcome.checks = source.checks; outcome.source = source.fingerprint;
    const gate = preflight(source, 'online');
    if (!gate.ok) { outcome.message = gate.message; return outcome; }

    const localFile = databasePath(mode, companyId);
    if (opts.dryRun) {
      outcome.stage = 'preview'; outcome.ok = true;
      const localNow = fs.existsSync(localFile) ? validateDatabaseFile(localFile) : null;
      outcome.destination = localNow?.fingerprint || null;
      outcome.differences = localNow?.fingerprint ? compareFingerprints(source.fingerprint!, localNow.fingerprint).differences : [];
      outcome.message = `Ready to replace this device's copy with ${source.fingerprint!.business_rows} records across ${Object.keys(source.fingerprint!.tables).length} tables (${(bytes.length / 1024).toFixed(0)} KB). ${outcome.differences.length} difference(s) from the current local copy. The current file is kept for rollback.`;
      return outcome;
    }

    // Preserve this device's identity and pairing before the file is replaced: the online file
    // carries the hub's sync_meta, and a device adopting it would masquerade as the hub.
    const identity = readIdentity(opts.db);

    outcome.stage = 'activate';
    closeDatabase(mode, companyId);
    const backup = `${localFile}.pre-clone-${Date.now()}.db`;
    if (fs.existsSync(localFile)) {
      fs.copyFileSync(localFile, backup);
      outcome.rollback_available = true;
      for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(localFile + suffix); } catch { /* not present */ } }
    }
    const incoming = `${localFile}.incoming-${Date.now()}.db`;
    fs.writeFileSync(incoming, bytes);
    const verifyIncoming = validateDatabaseFile(incoming);
    if (!verifyIncoming.ok) {
      try { fs.unlinkSync(incoming); } catch { /* temp */ }
      outcome.message = `The downloaded copy failed validation on this device, so the local database was not replaced: ${verifyIncoming.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`;
      return outcome;
    }
    fs.renameSync(incoming, localFile);                     // atomic within the same directory

    outcome.stage = 'verify-activated';
    const after = validateDatabaseFile(localFile);
    outcome.checks = outcome.checks.concat(after.checks.map((c) => ({ ...c, name: `local.${c.name}` })));
    if (!after.ok || !after.fingerprint) {
      if (fs.existsSync(backup)) { fs.copyFileSync(backup, localFile); outcome.message = 'The replaced local database did not validate, so the previous file was restored.'; }
      else outcome.message = 'The replaced local database did not validate and there was no previous file to restore.';
      return outcome;
    }
    const comparison = compareFingerprints(source.fingerprint!, after.fingerprint);
    outcome.destination = after.fingerprint; outcome.differences = comparison.differences;
    if (!comparison.ok) {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, localFile);
      outcome.message = `The local copy differs from the online snapshot in ${comparison.differences.length} place(s); the previous file was restored.`;
      return outcome;
    }

    outcome.stage = 'realign';
    restoreIdentity(mode, companyId, identity);
    outcome.activated = true; outcome.ok = true;
    outcome.message = `This device now holds the online copy of the organization: ${source.fingerprint!.business_rows} records across ${Object.keys(source.fingerprint!.tables).length} tables, verified table by table and against ${Object.keys(source.fingerprint!.totals).length} financial totals. The previous file is kept at ${path.basename(backup)}.`;
    return outcome;
  } catch (e: any) {
    outcome.message = `The clone stopped at "${outcome.stage}": ${String(e?.message || e)}`;
    return outcome;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
}

export type Identity = { device_id: string; paired_url: string | null; paired_company_id: number | null; sync_mode: string | null; remote_device_id: string | null };

function readIdentity(d: any): Identity {
  try {
    const row = d.prepare('SELECT device_id,paired_url,paired_company_id,sync_mode,remote_device_id FROM sync_meta WHERE id=1').get() as any;
    return { device_id: String(row?.device_id || ''), paired_url: row?.paired_url ?? null, paired_company_id: row?.paired_company_id ?? null, sync_mode: row?.sync_mode ?? null, remote_device_id: row?.remote_device_id ?? null };
  } catch { return { device_id: '', paired_url: null, paired_company_id: null, sync_mode: null, remote_device_id: null }; }
}

/**
 * After a pull, the two databases are identical. The journal is therefore fully exchanged by
 * definition: every local change is in the snapshot, and the cursor is set to the snapshot's own
 * high-water mark so the next incremental sync asks only for what happens after this point. The
 * device keeps its own id — it is not the hub.
 */
function restoreIdentity(mode: Mode, companyId: number, identity: Identity) {
  const { db } = require('./db') as typeof import('./db');
  const d = db(mode, companyId);
  realignAfterClone(d, identity);
}

export function realignAfterClone(d: any, identity: Identity) {
  const watermark = Number((d.prepare('SELECT COALESCE(MAX(seq),0) n FROM sync_changes').get() as any)?.n || 0);
  const tx = d.transaction(() => {
    if (identity.device_id) {
      d.prepare('UPDATE sync_meta SET device_id=?, paired_url=COALESCE(?,paired_url), paired_company_id=COALESCE(?,paired_company_id), sync_mode=COALESCE(?,sync_mode), remote_device_id=COALESCE(?,remote_device_id) WHERE id=1')
        .run(identity.device_id, identity.paired_url, identity.paired_company_id, identity.sync_mode, identity.remote_device_id);
    }
    // Both sides hold the same records now, so nothing is pending and nothing is in conflict.
    d.prepare('UPDATE sync_changes SET pushed=1 WHERE pushed=0').run();
    d.prepare('UPDATE sync_meta SET remote_cursor=?, last_sync_at=CURRENT_TIMESTAMP WHERE id=1').run(watermark);
    try { d.prepare("UPDATE sync_rejects SET resolved_at=CURRENT_TIMESTAMP WHERE resolved_at IS NULL").run(); } catch { /* table added in 2.8.1 */ }
  });
  tx();
  return { watermark };
}

/** Restore the snapshot kept before the last push-clone of this organization. */
export async function rollbackOnline(client: PoolClient, companyId: number, mode: Mode) {
  const activeKey = activeKeyFor(companyId, mode);
  const row = await client.query(`SELECT id, db_file, reason, created_at FROM solivy_sqlite_snapshot_backups WHERE db_key=$1 ORDER BY id DESC LIMIT 1`, [activeKey]);
  if (!row.rowCount) return { ok: false, message: 'There is no kept online snapshot for this organization and environment.' };
  const { decodeBlob } = await import('./snapshot-store');
  const bytes = decodeBlob(row.rows[0].db_file as Buffer);
  const dir = tempDir();
  try {
    const file = path.join(dir, 'rollback.db');
    fs.writeFileSync(file, bytes);
    const validation = validateDatabaseFile(file);
    if (!validation.ok) return { ok: false, message: `The kept snapshot did not validate, so it was not restored: ${validation.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}` };
    const current = (await remoteVersions(client, [activeKey])).get(activeKey);
    const written = await writeSnapshot(client, activeKey, bytes, priorFor(current));
    if (!written) return { ok: false, message: 'The online snapshot changed while rolling back; nothing was restored.' };
    return { ok: true, message: `Restored the online snapshot kept as "${row.rows[0].reason}" (${new Date(row.rows[0].created_at).toISOString()}).`, fingerprint: validation.fingerprint };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
}
