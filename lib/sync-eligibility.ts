/**
 * Table eligibility for synchronization — the single source of truth (v2.8.1).
 *
 * Before this module the same decision was written out three times with three different
 * memberships and three different error messages:
 *
 *   - lib/db.ts (the trigger builder)        12 names, including login_attempts
 *   - app/api/sync/exchange/route.ts (hub)   11 names, no login_attempts
 *   - app/api/sync/run/route.ts (device)      9 names, also missing the two v2.8.0 additions
 *
 * The divergence failed in both directions: a legacy device that journalled `login_attempts`
 * had those rows accepted by the hub, and a device still holding queued
 * `sync_resolution_log` / `sync_conflict_history` events was answered with the unexplained
 * "Table is not eligible for synchronization." (HTTP 409) — which, because a single bad event
 * aborted the whole batch, blocked every other change behind it permanently.
 *
 * Eligibility is now computed in one place, and an ineligible table is classified so the
 * caller can tell the two cases apart:
 *
 *   LOCAL_ONLY  bookkeeping that is rebuilt per device (the sync journal itself, session and
 *               licensing state). An event for one of these carries no business data, so it is
 *               ACCEPTED AND DROPPED as obsolete rather than raised as a conflict. Dropping it
 *               loses nothing and unblocks the queue behind it.
 *   UNKNOWN     a name that is not a synchronised table on this schema. Quarantined with the
 *               table named, never silently discarded.
 */
export type Eligibility =
  | { ok: true }
  | { ok: false; code: 'LOCAL_ONLY' | 'INVALID_NAME' | 'NOT_SYNCHRONISED'; message: string };

/** Per-device bookkeeping. Never synchronised; an inbound event for one of these is obsolete. */
export const LOCAL_ONLY_TABLES = new Set([
  'sync_meta', 'sync_changes', 'sync_applied_events', 'sync_id_mappings', 'sync_device_acks',
  'sync_resolution_log', 'sync_conflict_history', 'sync_rejects',
  'users', 'login_attempts', 'idempotency_keys',
  'sqlite_sequence', 'schema_migrations',
]);

/** Local-only by prefix: licensing state and admin-database mirrors. */
export function isLocalOnlyTable(table: string) {
  return LOCAL_ONLY_TABLES.has(table) || table.startsWith('license_') || table.startsWith('admin_');
}

/** Back-compatible alias for the three former `excluded` sets. */
export const SYNC_EXCLUDED_TABLES = LOCAL_ONLY_TABLES;

export function syncEligibility(table: string): Eligibility {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    return { ok: false, code: 'INVALID_NAME', message: `"${String(table).slice(0, 60)}" is not a valid table name, so the change cannot be identified. The item was quarantined and nothing else in the batch was affected.` };
  }
  if (isLocalOnlyTable(table)) {
    return { ok: false, code: 'LOCAL_ONLY', message: `"${table}" is per-device bookkeeping (sync journal, session or licensing state) and is never synchronised. The queued item was discarded as obsolete; no accounting data is affected.` };
  }
  return { ok: true };
}

/** Eligible *and* present in this database, with its columns and primary key. */
export function syncTableInfo(d: any, table: string): { ok: true; cols: any[]; pk: any[] } | { ok: false; code: string; message: string } {
  const el = syncEligibility(table);
  if (!el.ok) return el;
  const exists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return { ok: false, code: 'NOT_SYNCHRONISED', message: `Table "${table}" does not exist in this organization's database, so the change cannot be applied here. Upgrade this installation to the same schema version, then retry the quarantined item.` };
  const cols = d.prepare(`PRAGMA table_info("${table}")`).all() as any[];
  const pk = cols.filter((c: any) => Number(c.pk) > 0).sort((a: any, b: any) => a.pk - b.pk);
  if (!cols.length || !pk.length) return { ok: false, code: 'NO_PRIMARY_KEY', message: `Table "${table}" has no primary key, so a change to it cannot be matched to a record. The item was quarantined.` };
  return { ok: true, cols, pk };
}
