/**
 * Safe pruning of the synchronization journal (sync_changes).
 *
 * An event may be deleted only when ALL of these hold:
 *  - it is older than the retention window (default 30 days);
 *  - this database has delivered it upstream (pushed=1) or has no upstream pairing;
 *  - every device that pulls from this database and was active in the last 90 days has
 *    acknowledged a cursor at or beyond the event (sync_device_acks).
 * The highest pruned sequence is recorded as a watermark. A device that asks for history
 * below the watermark receives 410 SYNC_HISTORY_PRUNED and must re-baseline (restore a backup
 * or run the documented initial migration) instead of silently missing events.
 */
import { confirmSyncTriggers } from './db';

type DB = any;
export const RETENTION_DAYS = 30;
/**
 * Retention for a database nothing pulls from (no upstream pairing and no paired device): the
 * journal has no consumer, and a device paired later re-baselines from a backup (410
 * SYNC_HISTORY_PRUNED). Measured on a 1.9 MB organization file, sync_changes held 932 KB — 49% of
 * every snapshot hydration — so this is the difference between transferring data and transferring
 * transport history. The accounting audit trail (audit_logs) is never touched.
 */
export const UNPAIRED_RETENTION_DAYS = 2;
/** Prune outside the once-a-day throttle when the journal has grown past this many events. */
export const LARGE_JOURNAL_EVENTS = 400;

export function ensurePruneSchema(d: DB) {
  const before = Number(d.pragma('schema_version', { simple: true }));
  d.exec('CREATE TABLE IF NOT EXISTS sync_device_acks (device_id TEXT PRIMARY KEY, ack_cursor INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const cols = (d.prepare('PRAGMA table_info(sync_meta)').all() as any[]).map((c) => c.name);
  if (!cols.includes('pruned_through_seq')) d.exec('ALTER TABLE sync_meta ADD COLUMN pruned_through_seq INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('last_pruned_at')) d.exec('ALTER TABLE sync_meta ADD COLUMN last_pruned_at TEXT DEFAULT NULL');
  // This DDL only adds bookkeeping of its own; the synchronised tables and their triggers are
  // untouched, so confirm the triggers instead of letting the next open rebuild all of them.
  if (Number(d.pragma('schema_version', { simple: true })) !== before) confirmSyncTriggers(d);
}

/** Record that `deviceId` has applied everything up to `cursor` (only ever moves forward). */
export function recordAck(d: DB, deviceId: string, cursor: number) {
  if (!deviceId || !(cursor > 0)) return;
  const row = d.prepare('SELECT ack_cursor FROM sync_device_acks WHERE device_id=?').get(deviceId) as any;
  if (row && Number(row.ack_cursor) >= cursor) return;
  d.prepare('INSERT INTO sync_device_acks(device_id,ack_cursor,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(device_id) DO UPDATE SET ack_cursor=excluded.ack_cursor, updated_at=CURRENT_TIMESTAMP').run(deviceId, cursor);
}

export function watermark(d: DB): number {
  try { return Number((d.prepare('SELECT pruned_through_seq v FROM sync_meta WHERE id=1').get() as any)?.v || 0); } catch { return 0; }
}

/** True when a pull at `cursor` would miss pruned events. Preflight (cursor 0, limit 1) is allowed. */
export function historyPruned(d: DB, cursor: number, limit: number) {
  const w = watermark(d);
  if (!w) return false;
  if (cursor === 0) return limit > 1;
  return cursor < w;
}

export function pruneSyncJournal(d: DB, opts: { retentionDays?: number; now?: Date; force?: boolean; hasConsumers?: boolean } = {}) {
  ensurePruneSchema(d);
  const meta = d.prepare('SELECT paired_url, last_pruned_at FROM sync_meta WHERE id=1').get() as any;
  if (!meta) return { deleted: 0, watermark: 0, skipped: 'no sync_meta' };
  const now = opts.now || new Date();
  const acks = Number((d.prepare('SELECT COUNT(*) n FROM sync_device_acks').get() as any)?.n || 0);
  const hasUpstreamPairing = String(meta.paired_url || '').trim() !== '';
  const unconsumed = opts.hasConsumers === false && acks === 0 && !hasUpstreamPairing;
  const events = Number((d.prepare('SELECT COUNT(*) n FROM sync_changes').get() as any)?.n || 0);
  const throttled = meta.last_pruned_at && now.getTime() - Date.parse(meta.last_pruned_at + 'Z') < 23 * 3600 * 1000;
  if (!opts.force && throttled && !(unconsumed && events > LARGE_JOURNAL_EVENTS)) return { deleted: 0, watermark: watermark(d), skipped: 'pruned within the last day' };
  const retention = opts.retentionDays ?? (unconsumed ? UNPAIRED_RETENTION_DAYS : RETENTION_DAYS);
  const cutoff = new Date(now.getTime() - retention * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const activeSince = new Date(now.getTime() - 90 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const minAck = d.prepare('SELECT MIN(ack_cursor) m, COUNT(*) n FROM sync_device_acks WHERE updated_at >= ?').get(activeSince) as any;
  const hasUpstream = hasUpstreamPairing;
  const ackLimit = Number(minAck?.n || 0) > 0 ? Number(minAck.m) : Number.MAX_SAFE_INTEGER;
  const candidates = d.prepare(`SELECT MAX(seq) mx, COUNT(*) n FROM sync_changes WHERE created_at < ? AND seq <= ? ${hasUpstream ? 'AND pushed=1' : ''}`).get(cutoff, ackLimit) as any;
  let deleted = 0, mark = watermark(d);
  if (Number(candidates?.n || 0) > 0) {
    // Delete a contiguous prefix only, so the watermark is exact.
    const firstBlocked = d.prepare(`SELECT MIN(seq) s FROM sync_changes WHERE NOT (created_at < ? AND seq <= ? ${hasUpstream ? 'AND pushed=1' : ''})`).get(cutoff, ackLimit) as any;
    const upTo = firstBlocked?.s ? Math.min(Number(candidates.mx), Number(firstBlocked.s) - 1) : Number(candidates.mx);
    if (upTo > 0) {
      d.transaction(() => {
        deleted = d.prepare('DELETE FROM sync_changes WHERE seq <= ?').run(upTo).changes;
        mark = Math.max(mark, upTo);
        d.prepare('UPDATE sync_meta SET pruned_through_seq=? WHERE id=1').run(mark);
      })();
    }
  }
  d.prepare("DELETE FROM sync_applied_events WHERE applied_at < datetime('now','-180 days')").run();
  d.prepare('UPDATE sync_meta SET last_pruned_at=CURRENT_TIMESTAMP WHERE id=1').run();
  return { deleted, watermark: mark, retention_days: retention, unconsumed };
}
