import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminDb, databasePath, db, type Mode } from '../../../../lib/db';
import { withPostgresSQLiteBridge, markSnapshotReplaced } from '../../../../lib/postgres-sqlite-bridge';
import { postgresPool, usesPostgres } from '../../../../lib/postgres';
import { syncTokenContext } from '../../../../lib/sync-auth';
import { snapshotToFile, validateDatabaseFile, fingerprintOf, compareFingerprints, pushCloneToOnline, rollbackOnline, activeKeyFor, realignAfterClone } from '../../../../lib/clone-engine';
import { ensureCloneSchema, beginUpload, storeChunk, uploadState, assembleUpload, clearUpload, recordRun, cloneRuns, acquireCloneLock, releaseCloneLock } from '../../../../lib/clone-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * HUB side of the clone engine (v2.9.0).
 *
 * The online deployment is the only process with PostgreSQL access, so both directions are driven
 * over HTTP by the offline installation, authenticated with the same device token as
 * /api/sync/exchange and scoped to one organization and environment.
 *
 *   GET  ?action=manifest            the hub snapshot's size, sha, chunk count and fingerprint
 *   GET  ?action=chunk&no=N          one chunk of that snapshot (resumable download)
 *   POST {action:'begin'}            start a resumable upload: declares size, sha and fingerprint
 *   POST {action:'chunk'}            one chunk, idempotent by (upload_id, chunk_no)
 *   POST {action:'status'}           which chunks are still missing (resume after interruption)
 *   POST {action:'commit'}           assemble → validate → fingerprint → stage → activate
 *   POST {action:'rollback'}         restore the snapshot kept before the last activation
 *
 * A commit never activates an unverified or partial copy: the assembled bytes must match the
 * declared sha, the database must pass validation, and its fingerprint must equal the one the
 * device declared before the upload started.
 */
const CHUNK = 1024 * 1024;

function tempFile(name: string) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-hub-clone-')), name); }

async function withClient<T>(run: (client: any) => Promise<T>): Promise<T> {
  const client = await postgresPool().connect();
  try { return await run(client); } finally { client.release(); }
}

/** A consistent snapshot of the hub's own organization database, with its fingerprint. */
function hubSnapshot(mode: Mode, companyId: number) {
  const d = db(mode, companyId);
  const file = tempFile('hub.db');
  snapshotToFile(d, file);
  const validation = validateDatabaseFile(file);
  const bytes = fs.readFileSync(file);
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* temp */ }
  return { bytes, validation };
}

async function handler(req: Request) {
  if (!usesPostgres()) return NextResponse.json({ error: 'This installation has no online database configured, so it cannot serve a clone. Run the clone from the offline installation against the online site.' }, { status: 400 });
  let ctx;
  try { ctx = syncTokenContext(req); } catch (e: any) { return NextResponse.json({ error: e?.message || 'Unauthorized sync device.' }, { status: 401 }); }
  const organization = adminDb().prepare('SELECT name,active FROM companies WHERE id=?').get(ctx.companyId) as any;
  if (!organization || !organization.active) return NextResponse.json({ error: 'The paired destination organization is missing or inactive.' }, { status: 403 });
  const d = db(ctx.mode, ctx.companyId);

  try {
    if (req.method === 'GET') {
      const u = new URL(req.url);
      const action = String(u.searchParams.get('action') || 'manifest');
      if (action === 'manifest') {
        const { bytes, validation } = hubSnapshot(ctx.mode, ctx.companyId);
        return NextResponse.json({
          ok: validation.ok, size: bytes.length, sha: crypto.createHash('sha256').update(bytes).digest('hex'),
          chunk_size: CHUNK, chunks: Math.ceil(bytes.length / CHUNK), fingerprint: validation.fingerprint,
          checks: validation.checks, company_id: ctx.companyId, company_name: String(organization.name || ''), mode: ctx.mode,
        });
      }
      if (action === 'chunk') {
        const no = Math.max(0, Number(u.searchParams.get('no') || 0));
        const { bytes } = hubSnapshot(ctx.mode, ctx.companyId);
        const slice = bytes.subarray(no * CHUNK, (no + 1) * CHUNK);
        if (!slice.length) return NextResponse.json({ error: 'That chunk is past the end of the snapshot.' }, { status: 416 });
        return NextResponse.json({ ok: true, no, size: bytes.length, chunk_size: CHUNK, chunks: Math.ceil(bytes.length / CHUNK), sha: crypto.createHash('sha256').update(slice).digest('hex'), data: slice.toString('base64') });
      }
      if (action === 'status') return NextResponse.json({ ok: true, runs: await withClient(async (c) => { await ensureCloneSchema(c); return cloneRuns(c, ctx.companyId, ctx.mode, 10); }) });
      return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
    }

    if (req.method !== 'POST') return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action || '');

    if (action === 'begin') {
      const size = Number(body.size || 0);
      const sha = String(body.sha || '');
      if (!size || size > 2 * 1024 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(sha)) return NextResponse.json({ error: 'A clone upload must declare its size and sha256.' }, { status: 400 });
      return await withClient(async (client) => {
        await ensureCloneSchema(client);
        const lock = await acquireCloneLock(client, ctx);
        if (!lock.ok) return NextResponse.json({ error: lock.message, code: 'CLONE_IN_PROGRESS' }, { status: 409 });
        const uploadId = await beginUpload(client, ctx, { size, sha, chunkSize: CHUNK, fingerprint: body.fingerprint || null });
        const state = await uploadState(client, uploadId, ctx);
        return NextResponse.json({ ok: true, upload_id: uploadId, chunk_size: CHUNK, chunks: Math.ceil(size / CHUNK), missing: state.ok ? state.missing : undefined });
      });
    }

    if (action === 'chunk') {
      const uploadId = String(body.upload_id || '');
      const no = Number(body.chunk_no);
      const data = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : null;
      if (!uploadId || !Number.isInteger(no) || no < 0 || !data || !data.length) return NextResponse.json({ error: 'A chunk needs the upload id, its number and its data.' }, { status: 400 });
      const expected = String(body.sha || '');
      if (expected && crypto.createHash('sha256').update(data).digest('hex') !== expected) return NextResponse.json({ error: `Chunk ${no} did not arrive intact; send it again.` }, { status: 400 });
      return await withClient(async (client) => {
        await ensureCloneSchema(client);
        const state = await storeChunk(client, uploadId, ctx, no, data);
        if (!state.ok) return NextResponse.json({ error: state.message }, { status: 409 });
        return NextResponse.json({ ok: true, stored: no, received: state.received, chunks: state.chunks });
      });
    }

    if (action === 'status') {
      return await withClient(async (client) => {
        await ensureCloneSchema(client);
        const state = await uploadState(client, String(body.upload_id || ''), ctx);
        if (!state.ok) return NextResponse.json({ error: state.message }, { status: 404 });
        return NextResponse.json({ ...state, ok: true });
      });
    }

    if (action === 'commit') {
      const uploadId = String(body.upload_id || '');
      return await withClient(async (client) => {
        await ensureCloneSchema(client);
        const assembled = await assembleUpload(client, uploadId, ctx);
        if (!assembled.ok) return NextResponse.json({ error: assembled.message, missing: assembled.missing, code: 'INCOMPLETE_UPLOAD' }, { status: 409 });
        const file = tempFile('incoming.db');
        fs.writeFileSync(file, assembled.bytes!);
        let incoming: any = null;
        try {
          const validation = validateDatabaseFile(file);
          if (!validation.ok || !validation.fingerprint) {
            await recordRun(client, { companyId: ctx.companyId, mode: ctx.mode, direction: 'push', ok: false, stage: 'validate-upload', message: validation.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '), deviceId: ctx.deviceId });
            await releaseCloneLock(client, ctx);
            return NextResponse.json({ error: 'The uploaded database did not pass validation, so the online copy was not touched.', checks: validation.checks, stage: 'validate-upload' }, { status: 422 });
          }
          if (assembled.declaredFingerprint) {
            const comparison = compareFingerprints(assembled.declaredFingerprint, validation.fingerprint);
            if (!comparison.ok) {
              await recordRun(client, { companyId: ctx.companyId, mode: ctx.mode, direction: 'push', ok: false, stage: 'verify-upload', message: `${comparison.differences.length} difference(s) between the declared and the received copy`, deviceId: ctx.deviceId });
              await releaseCloneLock(client, ctx);
              return NextResponse.json({ error: 'What arrived does not match what the device declared, so the online copy was not touched.', differences: comparison.differences, stage: 'verify-upload' }, { status: 422 });
            }
          }
          // The hub keeps its OWN device identity. Activating the device's snapshot verbatim would
          // give the hub the device's device_id, and the hub would then journal its own changes as
          // if the device had made them — the device's pull filter (origin_device <> me) would
          // discard them and hub changes would silently never arrive. Local-only tables are
          // excluded from the fingerprint, so this does not weaken the verification.
          incoming = openIncoming(file, { readonly: false });
          realignAfterClone(incoming, hubIdentity(d));
          const outcome = await pushCloneToOnline(client, { companyId: ctx.companyId, mode: ctx.mode, db: incoming });
          await recordRun(client, { companyId: ctx.companyId, mode: ctx.mode, direction: 'push', ok: outcome.ok, stage: outcome.stage, message: outcome.message, deviceId: ctx.deviceId, source: outcome.source, destination: outcome.destination });
          if (outcome.ok) { await clearUpload(client, uploadId); markSnapshotReplaced(ctx.companyId, ctx.mode); }
          await releaseCloneLock(client, ctx);
          return NextResponse.json({ ...outcome, company_id: ctx.companyId, company_name: String(organization.name || ''), mode: ctx.mode }, { status: outcome.ok ? 200 : 422 });
        } finally {
          try { incoming?.close(); } catch { /* already closed */ }
          try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* temp */ }
        }
      });
    }
    if (action === 'rollback') {
      return await withClient(async (client) => {
        await ensureCloneSchema(client);
        const result = await rollbackOnline(client, ctx.companyId, ctx.mode);
        if (result.ok) markSnapshotReplaced(ctx.companyId, ctx.mode);
        await recordRun(client, { companyId: ctx.companyId, mode: ctx.mode, direction: 'rollback', ok: result.ok, stage: 'rollback', message: result.message, deviceId: ctx.deviceId });
        return NextResponse.json(result, { status: result.ok ? 200 : 409 });
      });
    }

    if (action === 'validate') {
      const file = tempFile('check.db');
      snapshotToFile(d, file);
      try { return NextResponse.json({ ok: true, online: validateDatabaseFile(file), key: activeKeyFor(ctx.companyId, ctx.mode) }); }
      finally { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* temp */ } }
    }

    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'The clone request failed.' }, { status: 500 });
  }
}

/** Open an assembled upload so the clone engine can patch identity, snapshot and fingerprint it. */
function openIncoming(file: string, opts: { readonly?: boolean } = {}) {
  const Database = require('better-sqlite3');
  const d = new Database(file, { readonly: opts.readonly !== false });
  if (opts.readonly === false) d.pragma('foreign_keys = ON');
  return d;
}

/** The hub's own synchronisation identity, which an activated clone must keep. */
function hubIdentity(d: any) {
  const row = d.prepare('SELECT device_id,paired_url,paired_company_id,sync_mode,remote_device_id FROM sync_meta WHERE id=1').get() as any;
  return { device_id: String(row?.device_id || ''), paired_url: row?.paired_url ?? null, paired_company_id: row?.paired_company_id ?? null, sync_mode: row?.sync_mode ?? null, remote_device_id: row?.remote_device_id ?? null };
}
void fingerprintOf; void databasePath;

// audit:false — the clone engine keeps its own durable run log in PostgreSQL
// (solivy_clone_runs). Writing an audit row into the organization file during a clone request
// would make the bridge persist that file at the end of the request, with the snapshot version it
// hydrated, which collides with the activation this request has just performed (CONCURRENT_UPDATE).
const options = { skipSessionCheck: true, audit: false, preAuthorize: (req: Request) => { try { const c = syncTokenContext(req); return { companyId: c.companyId, mode: c.mode }; } catch (e: any) { const err: any = new Error(e?.message || 'Unauthorized sync device.'); err.status = 401; throw err; } } };
const __wrapped_GET = withPostgresSQLiteBridge(handler, options);
const __wrapped_POST = withPostgresSQLiteBridge(handler, options);
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
