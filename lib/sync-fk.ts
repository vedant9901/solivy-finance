/**
 * Foreign-key dependency discovery for synchronization (v2.8.3).
 *
 * The reported failure was `parties · DELETE · id 15` →
 * "FOREIGN_KEY: Referenced tables not discoverable from this table schema."
 *
 * Two defects produced it:
 *
 *  1. The device-side apply deleted the row with no dependency guard at all (the hub had one), so
 *     SQLite raised a bare "FOREIGN KEY constraint failed".
 *  2. The message was then built from `PRAGMA foreign_key_list(parties)`, which lists the tables
 *     `parties` *points at* — it has none. What blocks a DELETE is the opposite direction: the
 *     tables that point *at* parties. So the diagnostic said "not discoverable" while twelve
 *     columns in eleven tables referenced the record.
 *
 * This module resolves both directions from the live schema, never from a hard-coded list, and
 * returns the blocking record identifiers so a conflict can name them.
 */
export type Reference = { table: string; column: string; parentColumn: string; count: number; ids: any[]; declared: boolean };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tables(d: any): string[] {
  return (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[])
    .map((t) => String(t.name)).filter((t) => IDENT.test(t));
}

function primaryKeyOf(d: any, table: string): string[] {
  try { return (d.prepare(`PRAGMA table_info("${table}")`).all() as any[]).filter((c: any) => Number(c.pk) > 0).map((c: any) => String(c.name)); } catch { return []; }
}

function rowIds(d: any, child: string, column: string, value: any, limit = 5) {
  const pk = primaryKeyOf(d, child);
  const select = pk.length ? pk.map((c) => `"${c}"`).join(',') : 'rowid';
  try {
    return (d.prepare(`SELECT ${select} FROM "${child}" WHERE "${column}"=? LIMIT ${limit}`).all(value) as any[])
      .map((r: any) => (pk.length === 1 ? r[pk[0]] : (pk.length ? pk.reduce((o: any, c) => ({ ...o, [c]: r[c] }), {}) : r.rowid)));
  } catch { return []; }
}

/**
 * Every row that currently references `key` in `parent`, declared foreign keys first.
 *
 * `declared: false` entries are columns that reference the parent by convention but have no
 * foreign key in the schema (for example `purchases.broker_party_id`). SQLite does not block a
 * deletion for those, so they would be left dangling: they are reported so the decision is made
 * knowingly, not discovered later as a broken reference.
 */
export function referencesTo(d: any, parent: string, key: Record<string, any>, opts: { includeUndeclared?: boolean } = {}): Reference[] {
  if (!IDENT.test(parent)) return [];
  const out: Reference[] = [];
  const parentPk = primaryKeyOf(d, parent);
  const singular = parent.replace(/ies$/, 'y').replace(/s$/, '');            // parties -> party
  const conventional = new RegExp(`(^|_)${singular}(_|$)|^${singular}_id$|_${singular}_id$`, 'i');

  for (const child of tables(d)) {
    let fks: any[] = [];
    try { fks = d.prepare(`PRAGMA foreign_key_list("${child}")`).all() as any[]; } catch { fks = []; }
    const declaredCols = new Set<string>();

    for (const fk of fks) {
      // The schema's spelling of the parent table may differ in case from the name being deleted.
      if (String(fk.table || '').toLowerCase() !== parent.toLowerCase()) continue;
      const column = String(fk.from || '');
      const parentColumn = String(fk.to || parentPk[0] || Object.keys(key)[0] || 'id');
      if (!IDENT.test(column)) continue;
      declaredCols.add(column);
      if (child === parent && column === parentColumn) continue;             // self-reference on the key itself
      const value = key[parentColumn] ?? key[Object.keys(key)[0]];
      if (value === undefined) continue;
      try {
        const count = Number((d.prepare(`SELECT COUNT(*) n FROM "${child}" WHERE "${column}"=?`).get(value) as any)?.n || 0);
        if (count > 0) out.push({ table: child, column, parentColumn, count, ids: rowIds(d, child, column, value), declared: true });
      } catch (e) {
        // Never report "no dependents" because the probe failed: that is how a blocked deletion
        // became a bare FOREIGN KEY error. Report it as blocking, with the count unknown.
        out.push({ table: child, column, parentColumn, count: -1, ids: [], declared: true });
      }
    }

    if (opts.includeUndeclared === false || child === parent) continue;
    let cols: any[] = [];
    try { cols = d.prepare(`PRAGMA table_info("${child}")`).all() as any[]; } catch { continue; }
    for (const c of cols) {
      const column = String(c.name);
      if (declaredCols.has(column) || !IDENT.test(column) || !/_id$/i.test(column) || !conventional.test(column)) continue;
      const value = key[parentPk[0] || 'id'] ?? key[Object.keys(key)[0]];
      if (value === undefined) continue;
      try {
        const count = Number((d.prepare(`SELECT COUNT(*) n FROM "${child}" WHERE "${column}"=?`).get(value) as any)?.n || 0);
        if (count > 0) out.push({ table: child, column, parentColumn: parentPk[0] || 'id', count, ids: rowIds(d, child, column, value), declared: false });
      } catch { /* a column shape that cannot be queried is not a reference */ }
    }
  }
  return out.sort((a, b) => Number(b.declared) - Number(a.declared) || a.table.localeCompare(b.table));
}

/** One line per blocking table, with the record identifiers, for a conflict message. */
export function describeReferences(refs: Reference[]) {
  return refs.map((r) => {
    const ids = r.ids.length ? ` (${r.ids.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')}${r.count > r.ids.length ? `, +${r.count - r.ids.length} more` : ''})` : '';
    const n = r.count < 0 ? 'an unknown number of' : String(r.count);
    return `${n} ${r.table.replace(/_/g, ' ')} via ${r.column}${ids}${r.declared ? '' : ' [no foreign key: would be left dangling]'}`;
  });
}

/**
 * The message for a failed sync apply. For a DELETE the blockers are the rows that reference the
 * record, so those are listed with their identifiers; for an INSERT or UPDATE the blockers are the
 * parents the row points at, which is what the previous version always reported.
 */
export function describeForeignKeyFailure(d: any, event: any, error: any) {
  const message = String(error?.message || error || 'Sync failed');
  if (!/foreign key constraint failed/i.test(message)) return message;
  const table = String(event?.table_name || 'unknown');
  const operation = String(event?.operation || 'unknown').toUpperCase();
  const pk = String(event?.pk_json || '');

  if (operation === 'DELETE') {
    let key: Record<string, any> = {};
    try { key = JSON.parse(pk || '{}'); } catch { key = {}; }
    const refs = referencesTo(d, table, key);
    if (refs.length) {
      return `Cannot delete ${table.replace(/_/g, ' ')} ${pk || ''}: it is still referenced by ${describeReferences(refs).join('; ')}. Nothing was deleted. Remove or reassign those records first, or deactivate this record instead of deleting it; the queued deletion stays retryable.`;
    }
    return `Cannot delete ${table.replace(/_/g, ' ')} ${pk || ''}: the database refused it for a foreign-key constraint, but no referencing row is visible on this device now. It may have been removed between the check and the delete — retry the quarantined item.`;
  }

  let refs: any[] = [];
  try { if (IDENT.test(table)) refs = d.prepare(`PRAGMA foreign_key_list("${table}")`).all(); } catch { /* unknown table shape */ }
  const parents = refs.map((r: any) => `${r.table}.${r.to || 'id'} via ${r.from}`).join(', ');
  return `Foreign key constraint failed while syncing ${table} (operation ${operation}, key ${pk || 'unknown'}). It depends on ${parents || 'a parent record that is not discoverable from this table schema'}. The item was not applied; the parent record must exist here first.`;
}

/** Tables whose rows are deactivated rather than deleted when history references them. */
export const SOFT_DELETE_TABLES: Record<string, string> = {
  parties: 'active', third_parties: 'active', company_accounts: 'active', godowns: 'active', companies: 'active',
};

/** Can this record be deactivated instead of deleted on this schema? */
export function softDeleteColumn(d: any, table: string): string | null {
  const column = SOFT_DELETE_TABLES[table];
  if (!column) return null;
  try { return (d.prepare(`PRAGMA table_info("${table}")`).all() as any[]).some((c: any) => String(c.name) === column) ? column : null; } catch { return null; }
}
