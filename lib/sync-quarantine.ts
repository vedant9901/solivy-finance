import crypto from 'node:crypto';

/**
 * Per-item quarantine for synchronization (v2.8.1).
 *
 * Until now a single unapplicable event rolled back the whole batch: the push marked nothing
 * as pushed, the pull committed no cursor, and the next attempt re-sent the same 500 events
 * and failed on the same first item. One stuck record therefore blocked every other change
 * on the device forever — the reported "push still does not sync".
 *
 * An item that cannot be applied is now recorded here, in full, instead of aborting its
 * batch. The rest of the batch applies. Nothing is discarded: the stored event is replayable
 * (`/api/sync/rejects` with `retry`), which is what makes a 409 recoverable after the user
 * resolves it. The table is per-device bookkeeping and is itself never synchronised.
 */
export const REJECTS_DDL = `CREATE TABLE IF NOT EXISTS sync_rejects (
  event_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk_json TEXT,
  operation TEXT,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT,
  event_json TEXT,
  origin_device TEXT,
  correlation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
)`;

export function ensureRejectSchema(d: any) {
  d.exec(REJECTS_DDL);
  d.exec('CREATE INDEX IF NOT EXISTS idx_sync_rejects_open ON sync_rejects(resolved_at,last_seen_at)');
}

export type RejectKind = 'quarantined' | 'obsolete';

export type RejectRecord = {
  phase: 'push' | 'pull';
  event: any;
  code: string;
  reason: string;
  detail?: any;
  correlationId?: string;
  kind?: RejectKind;
};

/** A correlation id for one sync run. Random; carries no account, user or device data. */
export function newCorrelationId() { return 'sync-' + crypto.randomUUID().slice(0, 18); }

/**
 * Diagnostics line for one rejected item. Primary keys and table names are included because
 * they are what makes a 409 actionable; row payloads, tokens and personal fields are not
 * logged. `pk_json` holds identifiers only (the journal never puts values in the key).
 */
export function logReject(r: RejectRecord) {
  try {
    console.error('SOLIVY sync reject', JSON.stringify({
      correlation_id: r.correlationId || null,
      phase: r.phase,
      table: String(r.event?.table_name || ''),
      key: String(r.event?.pk_json || ''),
      operation: String(r.event?.operation || ''),
      event_id: String(r.event?.event_id || ''),
      origin_device: String(r.event?.origin_device || ''),
      code: r.code,
      kind: r.kind || 'quarantined',
    }));
  } catch { /* diagnostics must never break a sync */ }
}

export function recordReject(d: any, r: RejectRecord) {
  ensureRejectSchema(d);
  const e = r.event || {};
  const eventId = String(e.event_id || 'unknown-' + crypto.randomUUID());
  d.prepare(`INSERT INTO sync_rejects(event_id,phase,table_name,pk_json,operation,code,reason,detail_json,event_json,origin_device,correlation_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET attempts=attempts+1,last_seen_at=CURRENT_TIMESTAMP,code=excluded.code,reason=excluded.reason,detail_json=excluded.detail_json,correlation_id=excluded.correlation_id,resolved_at=NULL`)
    .run(eventId, r.phase, String(e.table_name || ''), e.pk_json ? String(e.pk_json) : null, e.operation ? String(e.operation) : null,
      r.code, r.reason, r.detail ? JSON.stringify(r.detail) : null, JSON.stringify(e), e.origin_device ? String(e.origin_device) : null,
      r.correlationId || null);
  logReject(r);
  return { event_id: eventId, table: String(e.table_name || ''), primary_key: e.pk_json ? safeParse(e.pk_json) : null, operation: String(e.operation || ''), code: r.code, reason: r.reason, detail: r.detail || null, correlation_id: r.correlationId || null };
}

/** An obsolete item needs no user decision: it is recorded as resolved for the audit trail only. */
export function recordObsolete(d: any, r: RejectRecord) {
  const row = recordReject(d, { ...r, kind: 'obsolete' });
  d.prepare("UPDATE sync_rejects SET resolved_at=CURRENT_TIMESTAMP WHERE event_id=?").run(row.event_id);
  return row;
}

export function clearReject(d: any, eventId: string) {
  ensureRejectSchema(d);
  return d.prepare("UPDATE sync_rejects SET resolved_at=CURRENT_TIMESTAMP WHERE event_id=? AND resolved_at IS NULL").run(eventId).changes;
}

/**
 * Close every quarantined item for one record. Called after a conflict resolution succeeds, so
 * resolving a record clears the queue entry it was blocking instead of leaving it open forever.
 */
export function clearRejectsFor(d: any, table: string, key: any) {
  ensureRejectSchema(d);
  const rows = d.prepare('SELECT event_id,pk_json FROM sync_rejects WHERE table_name=? AND resolved_at IS NULL').all(String(table)) as any[];
  const want = canonKey(key);
  let closed = 0;
  for (const r of rows) {
    if (canonKey(safeParse(r.pk_json)) !== want) continue;
    closed += d.prepare('UPDATE sync_rejects SET resolved_at=CURRENT_TIMESTAMP WHERE event_id=?').run(String(r.event_id)).changes;
  }
  return closed;
}

function canonKey(k: any) {
  if (!k || typeof k !== 'object') return '';
  return Object.keys(k).sort().map((n) => `${n}=${String(k[n])}`).join('&');
}

export function openRejects(d: any, limit = 200) {
  ensureRejectSchema(d);
  return (d.prepare('SELECT event_id,phase,table_name,pk_json,operation,code,reason,detail_json,event_json,origin_device,correlation_id,attempts,first_seen_at,last_seen_at FROM sync_rejects WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as any[])
    .map((r) => ({ ...r, primary_key: safeParse(r.pk_json), detail: safeParse(r.detail_json) }));
}

export function openRejectCount(d: any) {
  ensureRejectSchema(d);
  return Number((d.prepare('SELECT COUNT(*) c FROM sync_rejects WHERE resolved_at IS NULL').get() as any)?.c || 0);
}

/** The stored events for replay. Used by the retry path so nothing depends on the cursor. */
export function rejectedEvents(d: any, eventIds?: string[]) {
  ensureRejectSchema(d);
  const rows = eventIds && eventIds.length
    ? eventIds.map((id) => d.prepare('SELECT event_id,event_json FROM sync_rejects WHERE event_id=? AND resolved_at IS NULL').get(String(id)) as any).filter(Boolean)
    : (d.prepare('SELECT event_id,event_json FROM sync_rejects WHERE resolved_at IS NULL AND phase=? ORDER BY first_seen_at LIMIT 200').all('pull') as any[]);
  return rows.map((r: any) => ({ event_id: String(r.event_id), event: safeParse(r.event_json) })).filter((r: any) => r.event);
}

/**
 * A quarantined item as the user needs to see it: which table, which record, what the two
 * sides hold now, why it stopped, and which resolutions are safe for that reason. The local
 * state is read live, so a record fixed in the meantime shows as resolvable.
 */
export function describeReject(d: any, r: any) {
  const table = String(r.table_name || '');
  const key = r.primary_key || safeParse(r.pk_json);
  let localRow: any = null;
  if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    try {
      const pk = (d.prepare(`PRAGMA table_info("${table}")`).all() as any[]).filter((c: any) => Number(c.pk) > 0);
      if (pk.length && pk.every((c: any) => Object.prototype.hasOwnProperty.call(key, c.name))) {
        localRow = d.prepare(`SELECT * FROM "${table}" WHERE ${pk.map((c: any) => `"${c.name}"=?`).join(' AND ')}`).get(...pk.map((c: any) => key[c.name])) || null;
      }
    } catch { /* schema differs; reported without the live row */ }
  }
  const ev = safeParse(r.event_json) || {};
  return {
    event_id: String(r.event_id), phase: String(r.phase), table, primary_key: key,
    operation: String(r.operation || ''), code: String(r.code), reason: String(r.reason),
    detail: r.detail || safeParse(r.detail_json), origin_device: r.origin_device || null,
    correlation_id: r.correlation_id || null, attempts: Number(r.attempts || 1),
    first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
    local_state: localRow, incoming_state: safeParse(ev.row_json), base_state: safeParse(ev.base_json),
    resolutions: resolutionsFor(String(r.code), String(r.phase)),
  };
}

/** Which actions are safe for a given rejection reason. Shown as the user's choices. */
function resolutionsFor(code: string, phase: string): Array<{ action: string; label: string }> {
  const retry = { action: 'retry', label: 'Retry now (after fixing what blocked it)' };
  const dismiss = { action: 'dismiss', label: 'Discard this queued change (recorded, not silent)' };
  if (code === 'FOREIGN_KEY') return [{ action: 'retry', label: 'Retry after the parent record has synchronised' }, dismiss];
  if (code === 'POSTED_RECORD') return [{ action: 'reverse', label: 'Reverse the posted record on the device that should not have it, then retry' }, dismiss];
  if (code === 'HAS_DEPENDENTS') return [{ action: 'resolve-cascade', label: 'Remove the record together with its dependent entries' }, retry, dismiss];
  if (code === 'DELETE_STALE' || code === 'DELETE_WITHOUT_BASE') return [{ action: 'keep-local', label: 'Keep this device\'s newer record' }, { action: 'confirm-delete', label: 'Confirm the deletion and discard the newer record' }, dismiss];
  if (code === 'NOT_SYNCHRONISED' || code === 'NO_PRIMARY_KEY') return [{ action: 'upgrade', label: 'Upgrade this installation to the same schema version, then retry' }, dismiss];
  if (phase === 'push') return [{ action: 'resolve', label: 'Choose which version to keep, then retry' }, retry, dismiss];
  return [retry, dismiss];
}

function safeParse(v: any) { if (v === null || v === undefined) return null; try { return JSON.parse(String(v)); } catch { return null; } }
