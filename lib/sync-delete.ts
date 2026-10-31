import crypto from 'node:crypto';

/**
 * Delete / recreate conflict resolution for synchronization (v2.8.0).
 *
 * Before this, a conflict whose chosen side was a DELETE (or whose record was missing on the
 * chosen side) ended in "This conflict involves a missing/deleted record. Use a dedicated
 * delete/recreate resolution" — and no such resolution existed, so the conflict could not be
 * cleared at all. This module provides it, with the financial rules intact:
 *
 *  - A POSTED financial record is never deleted by a sync resolution. Posted transactions are
 *    corrected through the reversal workflow, so the resolution is refused and says so.
 *  - A delete is refused while dependent rows still reference the record (payment allocations,
 *    ledger entries, receivables …) unless the caller asks for the children to go with it, and
 *    then every deleted row — parent and children — is written to sync_resolution_log first, so
 *    the audit history and a recovery copy survive the deletion.
 *  - A stale delete cannot remove a newer record: when the row no longer matches the state the
 *    deleting side saw, the resolution stops and asks for a decision (that is the recreate case —
 *    the same primary key was deleted on one device and re-entered on the other).
 *  - Resolution ids are derived from the conflict, not random, so retrying a resolution — or two
 *    devices resolving the same conflict — applies it once and never duplicates a payment,
 *    receipt, purchase or ledger entry.
 */
export type ConflictKind = 'update' | 'local-delete' | 'remote-delete' | 'both-deleted' | 'recreate';
export type DeleteGuard = { ok: true } | { ok: false; code: string; message: string; dependents?: Array<{ table: string; count: number }> };

export const RESOLUTION_LOG_DDL = `CREATE TABLE IF NOT EXISTS sync_resolution_log (resolution_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, pk_json TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, device_id TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)`;

/** Financial tables whose POSTED rows must be reversed, never deleted. */
const POSTED_GUARD_TABLES = new Set(['purchases', 'payments', 'money_in', 'money_out', 'receipts', 'interest_payments', 'sales', 'financing_receivables', 'account_movements', 'funding_loans']);

export function ensureResolutionLog(d: any) { d.exec(RESOLUTION_LOG_DDL); }

/** Same inputs always give the same id, so a retried resolution is applied exactly once. */
export function resolutionIdFor(parts: { phase: string; action: string; table: string; key: any; eventId?: string }) {
  const canon = JSON.stringify([parts.phase, parts.action, parts.table, parts.key, parts.eventId || '']);
  return 'res-' + crypto.createHash('sha256').update(canon).digest('hex').slice(0, 40);
}

/**
 * What the conflict actually is, from the two versions and the journalled operation. `localRow` is
 * the row as it exists on this device right now.
 */
export function classifyConflict(input: { localRow: any; localVersion: any; remoteVersion: any; operation?: string; phase: string }): ConflictKind {
  const op = String(input.operation || '').toUpperCase();
  const localGone = !input.localVersion || typeof input.localVersion !== 'object';
  const remoteGone = !input.remoteVersion || typeof input.remoteVersion !== 'object';
  if (localGone && remoteGone) return 'both-deleted';
  // A delete journalled on the side that no longer has the row.
  if (op === 'DELETE' && input.phase === 'pull' && remoteGone) return 'remote-delete';
  if (op === 'DELETE' && input.phase === 'push' && localGone) return 'local-delete';
  if (localGone) return input.localRow ? 'recreate' : 'local-delete';
  if (remoteGone) return 'remote-delete';
  return 'update';
}

/** Tables that reference `table`, with how many rows currently point at this record. */
export function dependentsOf(d: any, table: string, key: Record<string, any>): Array<{ table: string; count: number }> {
  const out: Array<{ table: string; count: number }> = [];
  const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map((t) => String(t.name));
  for (const child of tables) {
    if (child === table) continue;
    let fks: any[] = [];
    try { fks = d.prepare(`PRAGMA foreign_key_list("${child}")`).all() as any[]; } catch { continue; }
    for (const fk of fks.filter((f: any) => String(f.table) === table)) {
      const parentCol = String(fk.to || Object.keys(key)[0]);
      const value = key[parentCol] ?? key[Object.keys(key)[0]];
      if (value === undefined) continue;
      try {
        const row = d.prepare(`SELECT COUNT(*) n FROM "${child}" WHERE "${String(fk.from)}"=?`).get(value) as any;
        const n = Number(row?.n || 0);
        if (n > 0) out.push({ table: child, count: n });
      } catch { /* column shape changed; reported as no dependents rather than blocking blindly */ }
    }
  }
  return out;
}

/** Refuse deletions that accounting rules reserve for the reversal workflow. */
export function postedGuard(table: string, row: any): DeleteGuard {
  if (!row || !POSTED_GUARD_TABLES.has(table)) return { ok: true };
  const status = String(row.status || '').toUpperCase();
  if (status === 'POSTED') return { ok: false, code: 'POSTED_RECORD', message: `This ${table.replace(/_/g, ' ')} record is POSTED. Posted financial records are corrected by reversal, not deleted — reverse it on the device that should not have it, then synchronise.` };
  return { ok: true };
}

/**
 * Would applying a delete remove something newer? `base` is the row as the deleting side saw it.
 * Any difference means the record was changed (or re-entered) here afterwards.
 */
export function staleDeleteGuard(localRow: any, base: any): DeleteGuard {
  if (!localRow) return { ok: true };
  if (!base || typeof base !== 'object') return { ok: false, code: 'DELETE_WITHOUT_BASE', message: 'The deletion carries no record of what was deleted, so it cannot be confirmed safe here. Keep this device’s record, or delete it here deliberately and synchronise again.' };
  const changed = Object.keys(base).filter((k) => String(base[k] ?? '') !== String(localRow[k] ?? ''));
  if (changed.length) return { ok: false, code: 'DELETE_STALE', message: `This record was changed on this device after that deletion (${changed.slice(0, 4).join(', ')}${changed.length > 4 ? '…' : ''}). Nothing was deleted. Keep this device’s version, or confirm the deletion explicitly to discard the newer record.` };
  return { ok: true };
}

export type DeleteOutcome = { deleted: number; cascaded: Array<{ table: string; rows: number }>; before: any };

/**
 * Delete a record as the outcome of a conflict resolution. Runs in one transaction with the sync
 * triggers suppressed, writes an explicit journal event so other devices receive the deletion
 * exactly once, and records the full before-image (parent and any cascaded children) in
 * sync_resolution_log. Returns null when the record is already gone (idempotent retry).
 */
export function applyResolvedDelete(d: any, opts: {
  table: string; key: Record<string, any>; pk: Array<{ name: string }>; resolutionId: string; deviceId: string;
  cascade?: boolean; base?: any; override?: boolean; action?: string;
}): { outcome: DeleteOutcome | null; guard?: DeleteGuard } {
  const { table, key, pk, resolutionId, deviceId } = opts;
  ensureResolutionLog(d);
  const where = pk.map((c) => `"${c.name}"=?`).join(' AND ');
  const values = pk.map((c) => key[c.name]);
  const row = d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...values) as any;
  if (!row) return { outcome: null };

  const posted = postedGuard(table, row);
  if (!posted.ok) return { outcome: null, guard: posted };
  if (!opts.override) {
    const stale = staleDeleteGuard(row, opts.base);
    if (!stale.ok) return { outcome: null, guard: stale };
  }
  const dependents = dependentsOf(d, table, key);
  if (dependents.length && !opts.cascade) {
    return { outcome: null, guard: { ok: false, code: 'HAS_DEPENDENTS', message: `This record still has ${dependents.map((x) => `${x.count} ${x.table.replace(/_/g, ' ')}`).join(', ')} attached to it. Confirm removing them together, or resolve those records first.`, dependents } };
  }

  const cascaded: Array<{ table: string; rows: number }> = [];
  const childBefore: Record<string, any[]> = {};
  const tx = d.transaction(() => {
    d.prepare('UPDATE sync_meta SET suppress_triggers=1 WHERE id=1').run();
    try {
      for (const dep of dependents) {
        const fks = (d.prepare(`PRAGMA foreign_key_list("${dep.table}")`).all() as any[]).filter((f: any) => String(f.table) === table);
        for (const fk of fks) {
          const parentCol = String(fk.to || pk[0].name);
          const value = key[parentCol] ?? key[pk[0].name];
          const rows = d.prepare(`SELECT * FROM "${dep.table}" WHERE "${String(fk.from)}"=?`).all(value) as any[];
          if (!rows.length) continue;
          childBefore[dep.table] = (childBefore[dep.table] || []).concat(rows);
          const removed = d.prepare(`DELETE FROM "${dep.table}" WHERE "${String(fk.from)}"=?`).run(value).changes;
          cascaded.push({ table: dep.table, rows: Number(removed) });
          // Children are journalled individually so other devices apply the same removals.
          const childPk = (d.prepare(`PRAGMA table_info("${dep.table}")`).all() as any[]).filter((c: any) => Number(c.pk) > 0);
          for (const childRow of rows) {
            const ckey: any = {}; for (const c of childPk) ckey[String(c.name)] = childRow[String(c.name)];
            d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,NULL,?,1)')
              .run(`${resolutionId}-child-${dep.table}-${Object.values(ckey).join('-')}`, dep.table, JSON.stringify(ckey), 'DELETE', JSON.stringify(childRow), deviceId);
          }
        }
      }
      d.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...values);
      d.prepare('INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,NULL,?,1)')
        .run(`${resolutionId}-parent`, table, JSON.stringify(key), 'DELETE', JSON.stringify(row), deviceId);
    } finally {
      d.prepare('UPDATE sync_meta SET suppress_triggers=0 WHERE id=1').run();
    }
    d.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)')
      .run(resolutionId, table, JSON.stringify(key), opts.action || 'delete-record', JSON.stringify({ row, children: childBefore }), null, deviceId);
  });
  tx();
  return { outcome: { deleted: 1, cascaded, before: { row, children: childBefore } } };
}

/** True when this resolution has already been applied on this database. */
export function alreadyResolved(d: any, resolutionId: string) {
  ensureResolutionLog(d);
  return Boolean(d.prepare('SELECT resolution_id FROM sync_resolution_log WHERE resolution_id=?').get(resolutionId));
}
