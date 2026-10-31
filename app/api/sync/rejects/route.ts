import { NextResponse } from 'next/server';
import { db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { openRejects, rejectedEvents, clearReject, ensureRejectSchema, describeReject } from '../../../../lib/sync-quarantine';
import { reconcileIncomingEvent } from '../../../../lib/sync-id-mapping';
import { applyLocal } from '../../../../lib/sync-apply';
import { referencesTo, describeReferences, softDeleteColumn } from '../../../../lib/sync-fk';
import { resolutionIdFor, ensureResolutionLog, alreadyResolved } from '../../../../lib/sync-delete';
import { adminDb } from '../../../../lib/db';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The retry / reconcile path for quarantined sync items (v2.8.1).
 *
 * GET  lists every item that could not be applied, with its table, record key, operation,
 *      the two sides' states and the reason — the detail the roadmap asks a conflict to show.
 * POST { action:'retry', event_ids:[…] } replays the stored events. A pull item is applied
 *      locally again (after the user has fixed what blocked it); a push item only needs its
 *      quarantine entry cleared, because it was never marked pushed and the next run re-sends it.
 * POST { action:'dismiss', event_ids:[…] } closes an item deliberately. The stored event stays
 *      in sync_rejects, so a dismissal is recorded rather than a change being lost.
 */
function context(req: Request) {
  const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
  const mode = String(req.headers.get('x-aksh-mode') || '');
  if (!companyId || !['LIVE', 'TEST'].includes(mode)) throw new Error('Select an organization and environment first.');
  return { companyId, mode: mode as Mode };
}

async function handler(req: Request) {
  let ctx: { companyId: number; mode: Mode };
  try { ctx = context(req); } catch (e: any) { return NextResponse.json({ error: e?.message || 'Invalid request.' }, { status: 400 }); }
  const d = db(ctx.mode, ctx.companyId);
  ensureRejectSchema(d);
  if (req.method === 'GET') {
    const items = openRejects(d).map((r: any) => describeReject(d, r));
    return NextResponse.json({ ok: true, items, count: items.length });
  }
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action || '');
    const ids = Array.isArray(body?.event_ids) ? body.event_ids.map((x: any) => String(x)).slice(0, 200) : [];
    if (!ids.length) return NextResponse.json({ error: 'Select at least one quarantined item.' }, { status: 400 });
    if (action === 'dismiss') {
      // A dismissed push item must also stop being re-sent, or it keeps blocking the queue — the
      // defect this release repairs. The event itself and its reason stay in sync_rejects, so the
      // change is recorded as deliberately discarded rather than silently dropped.
      let closed = 0;
      const tx = d.transaction(() => {
        for (const id of ids) {
          closed += clearReject(d, id);
          const row = d.prepare('SELECT phase FROM sync_rejects WHERE event_id=?').get(id) as any;
          if (row && String(row.phase) === 'push') d.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(id);
          else d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(id);
        }
      });
      tx();
      return NextResponse.json({ ok: true, dismissed: closed });
    }
    if (action === 'deactivate') {
      // v2.8.3: the safe outcome for a deletion blocked by financial history. The record is
      // deactivated instead of deleted, as an ordinary journalled UPDATE so the other device
      // receives the same state, and the queued deletion is recorded as resolved this way rather
      // than discarded. Idempotent: the resolution id is derived from the record.
      ensureResolutionLog(d);
      const done: any[] = []; const refused: any[] = [];
      for (const id of ids) {
        const row = d.prepare('SELECT phase,table_name,pk_json,event_json FROM sync_rejects WHERE event_id=? AND resolved_at IS NULL').get(id) as any;
        if (!row) { refused.push({ event_id: id, reason: 'Not an open quarantined item.' }); continue; }
        const table = String(row.table_name);
        const column = softDeleteColumn(d, table);
        if (!column) { refused.push({ event_id: id, reason: `${table.replace(/_/g, ' ')} records cannot be deactivated on this schema; resolve the referencing records instead.` }); continue; }
        let key: any = {}; try { key = JSON.parse(String(row.pk_json || '{}')); } catch { key = {}; }
        const pk = (d.prepare(`PRAGMA table_info("${table}")`).all() as any[]).filter((c: any) => Number(c.pk) > 0);
        if (!pk.length || !pk.every((c: any) => Object.prototype.hasOwnProperty.call(key, c.name))) { refused.push({ event_id: id, reason: 'The record key is incomplete.' }); continue; }
        const where = pk.map((c: any) => `"${c.name}"=?`).join(' AND ');
        const values = pk.map((c: any) => key[c.name]);
        const current = d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...values) as any;
        if (!current) { refused.push({ event_id: id, reason: 'The record is already absent here; retry the item instead.' }); continue; }
        const resolutionId = resolutionIdFor({ phase: String(row.phase), action: 'deactivate', table, key, eventId: id });
        if (alreadyResolved(d, resolutionId)) { clearReject(d, id); done.push({ event_id: id, already_resolved: true }); continue; }
        const refs = referencesTo(d, table, key);
        const tx = d.transaction(() => {
          // Journalled deliberately (triggers stay on) so the deactivation synchronises.
          d.prepare(`UPDATE "${table}" SET "${column}"=0 WHERE ${where}`).run(...values);
          if (String(row.phase) === 'push') d.prepare('UPDATE sync_changes SET pushed=1 WHERE event_id=?').run(id);
          else d.prepare('INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)').run(id);
          d.prepare('INSERT OR IGNORE INTO sync_resolution_log(resolution_id,table_name,pk_json,action,before_json,after_json,device_id) VALUES(?,?,?,?,?,?,?)')
            .run(resolutionId, table, JSON.stringify(key), 'deactivate-instead-of-delete', JSON.stringify(current), JSON.stringify({ ...current, [column]: 0 }), String((d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any)?.device_id || ''));
        });
        tx();
        clearReject(d, id);
        done.push({ event_id: id, table, primary_key: key, deactivated: true, column, preserved: describeReferences(refs) });
      }
      return NextResponse.json({ ok: refused.length === 0, deactivated: done.length, done, refused });
    }
    if (action !== 'retry') return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
    const stored = rejectedEvents(d, ids);
    const applied: string[] = []; const still: any[] = [];
    const organization = adminDb().prepare('SELECT name FROM companies WHERE id=?').get(ctx.companyId) as any;
    for (const item of stored) {
      try {
        // Replayed from the stored event, not from the sync cursor, so the cursor having moved on
        // never makes a quarantined change unrecoverable.
        const once = d.transaction(() => {
          const mapped: any[] = [];
          const e = reconcileIncomingEvent(d, item.event, String(item.event?.origin_device || 'remote-device'), mapped);
          return applyLocal(d, e, String(organization?.name || ''));
        });
        once();
        clearReject(d, item.event_id); applied.push(item.event_id);
      } catch (err: any) {
        still.push({ event_id: item.event_id, code: String(err?.syncCode || err?.conflictDetail?.code || 'CONFLICT'), reason: String(err?.message || 'Still cannot be applied.'), detail: err?.conflictDetail || null });
      }
    }
    // Push-phase items hold no local work: clearing them is enough, the next run re-sends them.
    for (const id of ids) {
      if (applied.includes(id) || still.some((s) => s.event_id === id)) continue;
      const row = d.prepare('SELECT phase FROM sync_rejects WHERE event_id=?').get(id) as any;
      if (row && String(row.phase) === 'push') { clearReject(d, id); applied.push(id); }
    }
    return NextResponse.json({ ok: still.length === 0, retried: applied.length, applied, still_blocked: still });
  }
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });
}
const __wrapped_GET = withPostgresSQLiteBridge(handler);
const __wrapped_POST = withPostgresSQLiteBridge(handler);
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
