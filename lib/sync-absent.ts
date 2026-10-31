/**
 * What to do when the record is absent on the receiving side (v2.8.1).
 *
 * Both apply paths previously answered every such event with the same unexplained conflict —
 * "Cannot merge <table>: the base record was deleted locally" / "...deleted on the
 * destination while the other side changed it" — whatever the operation was. Two consequences
 * were reported from the field:
 *
 *   - A DELETE whose record was already gone here (absent on both sides) raised a conflict,
 *     even though there is nothing to decide: the two sides already agree.
 *   - An UPDATE for a record this side never received raised a conflict with no information
 *     about why, and (because one failure aborted the batch) blocked everything behind it.
 *
 * The decision is now deterministic per operation, and explained:
 *
 *   DELETE, record absent         -> NOOP. Both sides agree; the event is marked applied so it
 *                                   is never re-sent. Idempotent on retry.
 *   INSERT, record absent         -> APPLY (the normal insert path).
 *   UPDATE/INSERT with a base,
 *     record absent, a deletion
 *     recorded here for that key  -> OBSOLETE. A deliberate deletion on this side is not undone
 *                                   by an edit made elsewhere against the version that was
 *                                   removed. The event is quarantined (never discarded), so it
 *                                   can be pushed back deliberately if the deletion was wrong.
 *   UPDATE/INSERT with a base,
 *     record absent, no deletion
 *     recorded here               -> REVIVE. This side never received the record (a lost
 *                                   insert, a re-baselined device, a pruned journal). The
 *                                   sender holds the only copy, so it is inserted rather than
 *                                   dropped. No newer data can be overwritten: there is none.
 */
export type AbsentDecision =
  | { kind: 'noop'; code: string; reason: string }
  | { kind: 'revive'; code: string; reason: string }
  | { kind: 'obsolete'; code: string; reason: string };

/** A DELETE recorded on this side for the same table and key, if the journal still holds one. */
export function tombstoneFor(d: any, table: string, pkJson: string): { seq: number; at: string } | null {
  try {
    const row = d.prepare("SELECT seq,created_at FROM sync_changes WHERE table_name=? AND pk_json=? AND UPPER(operation)='DELETE' ORDER BY seq DESC LIMIT 1").get(table, pkJson) as any;
    if (row) return { seq: Number(row.seq || 0), at: String(row.created_at || '') };
  } catch { /* journal shape differs on very old installs; treated as no tombstone */ }
  try {
    const res = d.prepare("SELECT resolved_at FROM sync_resolution_log WHERE table_name=? AND pk_json=? AND action LIKE '%delete%' ORDER BY resolved_at DESC LIMIT 1").get(table, pkJson) as any;
    if (res) return { seq: 0, at: String(res.resolved_at || '') };
  } catch { /* resolution log may not exist yet */ }
  return null;
}

export function decideAbsent(d: any, e: { table_name: string; pk_json: string; operation?: string }, base: any): AbsentDecision {
  const table = String(e.table_name || '');
  const op = String(e.operation || '').toUpperCase();
  const key = String(e.pk_json || '');
  if (op === 'DELETE') {
    return { kind: 'noop', code: 'ALREADY_ABSENT', reason: `${label(table)} ${key} is already absent here, which is what the deletion asked for. Both sides agree; nothing to review.` };
  }
  if (base === null || base === undefined) {
    return { kind: 'revive', code: 'INSERT_ABSENT', reason: `${label(table)} ${key} does not exist here yet and is created from the incoming record.` };
  }
  const tomb = tombstoneFor(d, table, key);
  if (tomb) {
    return { kind: 'obsolete', code: 'DELETED_HERE', reason: `${label(table)} ${key} was deliberately deleted on this side${tomb.at ? ` (${tomb.at})` : ''}, so an edit made elsewhere against the removed version is not applied. The change is kept in the quarantine and can be pushed back if the deletion was wrong.` };
  }
  return { kind: 'revive', code: 'NEVER_RECEIVED', reason: `${label(table)} ${key} was never received on this side and no deletion is recorded for it, so the incoming record is restored rather than dropped.` };
}

function label(table: string) { return table.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
