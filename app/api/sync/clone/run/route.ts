import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminDb, databasePath, db, closeDatabase, type Mode } from '../../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../../lib/postgres-sqlite-bridge';
import { snapshotToFile, validateDatabaseFile, compareFingerprints, realignAfterClone } from '../../../../../lib/clone-engine';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DEVICE side of the clone engine (v2.9.0): the offline installation drives both directions.
 *
 *   POST { direction:'push', preview:true }   what would be uploaded, with record counts
 *   POST { direction:'push', confirm:'…' }    snapshot → validate → resumable upload → hub verifies
 *                                             and activates → realign the local journal
 *   POST { direction:'pull', preview:true }   what would be downloaded and how it differs from here
 *   POST { direction:'pull', confirm:'…' }    download in chunks → validate → atomic local swap,
 *                                             keeping the previous file → realign
 *   POST { direction:'validate' }             validate both databases without changing anything
 *   POST { direction:'rollback-online' }      ask the hub to restore the snapshot it kept
 *
 * Replacing a database is destructive, so every run that is not a preview must carry
 * `confirm: "REPLACE <ONLINE|OFFLINE> <ORGANISATION NAME> <LIVE|TEST>"`. Only an administrator of
 * the organization can run it, and a run is refused while another clone of the same organization
 * and environment is in progress (the hub holds that lock in PostgreSQL).
 */
const DOWNLOAD_RETRIES = 3;

function safeRemote(raw: string) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash) throw new Error('Remote URL must not contain credentials, query strings or fragments.');
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('The online URL must use HTTPS.');
  return u.toString().replace(/\/+$/, '');
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'solivy-device-clone-'));

async function handler(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
  const mode = String(req.headers.get('x-aksh-mode') || '');
  if (req.headers.get('x-aksh-role') !== 'ADMIN') return NextResponse.json({ error: 'Only an administrator can clone an organization database.' }, { status: 403 });
  if (!companyId || !['LIVE', 'TEST'].includes(mode)) return NextResponse.json({ error: 'Select an organization and environment first.' }, { status: 400 });

  const direction = String(body.direction || '');
  const organization = adminDb().prepare('SELECT name FROM companies WHERE id=?').get(companyId) as any;
  const organizationName = String(organization?.name || '');
  const local = db(mode as Mode, companyId);
  // The hub identifies this installation by its own device id, not by anything the caller sends.
  body.device_id = readIdentity(local).device_id;

  if (direction === 'validate') {
    const dir = tempDir();
    try {
      const file = snapshotToFile(local, path.join(dir, 'local.db'));
      const offline = validateDatabaseFile(file);
      let online: any = null;
      if (body.remote_url) {
        const manifest = await hubGet(body, 'manifest');
        online = manifest.ok === false ? { ok: false, checks: manifest.checks || [], error: manifest.error } : { ok: manifest.ok, checks: manifest.checks, fingerprint: manifest.fingerprint, size: manifest.size };
      }
      // Comparing two live databases: an append-only log row one side has not received yet is a
      // pending change, not a disagreement, and is reported as such rather than as a difference.
      const differences = online?.fingerprint && offline.fingerprint ? compareFingerprints(offline.fingerprint, online.fingerprint, { appendOnly: 'ignore' }).differences : [];
      return NextResponse.json({ ok: offline.ok && (online ? online.ok !== false : true), offline, online, differences, organization: organizationName, mode });
    } catch (e: any) { return NextResponse.json({ error: e?.message || 'Validation failed.' }, { status: 502 }); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
  }

  if (direction === 'rollback-online') {
    try {
      const r = await hubPost(body, { action: 'rollback' });
      return NextResponse.json(r.json, { status: r.status });
    } catch (e: any) { return NextResponse.json({ error: e?.message || 'The rollback request failed.' }, { status: 502 }); }
  }

  if (direction !== 'push' && direction !== 'pull') return NextResponse.json({ error: 'Choose push (offline to online) or pull (online to offline).' }, { status: 400 });

  const expected = `REPLACE ${direction === 'push' ? 'ONLINE' : 'OFFLINE'} ${organizationName} ${mode}`;
  const preview = body.preview === true;
  if (!preview && String(body.confirm || '').trim() !== expected) {
    return NextResponse.json({ error: `This replaces the ${direction === 'push' ? 'online' : 'offline'} copy of "${organizationName}" (${mode}). Type exactly: ${expected}`, confirmation_required: expected }, { status: 428 });
  }

  const dir = tempDir();
  try {
    if (direction === 'push') {
      // 1. A consistent snapshot of this device, validated before anything leaves the machine.
      const file = snapshotToFile(local, path.join(dir, 'source.db'));
      const source = validateDatabaseFile(file);
      if (!source.ok || !source.fingerprint) {
        return NextResponse.json({ ok: false, stage: 'validate-source', error: `This device's database did not pass validation, so nothing was uploaded: ${source.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`, checks: source.checks }, { status: 422 });
      }
      const bytes = fs.readFileSync(file);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (preview) {
        return NextResponse.json({ ok: true, stage: 'preview', direction, size: bytes.length, sha, fingerprint: source.fingerprint, checks: source.checks, confirmation_required: expected, message: `${source.fingerprint.business_rows} records across ${Object.keys(source.fingerprint.tables).length} tables (${(bytes.length / 1024).toFixed(0)} KB) would replace the online copy of "${organizationName}" (${mode}) after the upload is verified there.` });
      }

      // 2. Resumable upload. The hub stores each chunk in PostgreSQL, so an interruption or a
      //    restart resumes from what already arrived instead of starting again.
      const begun = await hubPost(body, { action: 'begin', size: bytes.length, sha, fingerprint: source.fingerprint });
      if (begun.status !== 200) return NextResponse.json({ ok: false, stage: 'begin', ...begun.json }, { status: begun.status });
      const uploadId = String(begun.json.upload_id);
      const chunkSize = Number(begun.json.chunk_size || 1024 * 1024);
      const total = Math.ceil(bytes.length / chunkSize);
      let state = await hubPost(body, { action: 'status', upload_id: uploadId });
      let missing: number[] = state.status === 200 && Array.isArray(state.json.missing) ? state.json.missing : Array.from({ length: total }, (_, i) => i);
      if (state.status === 200 && state.json.complete) missing = [];
      let sent = 0;
      for (const no of missing) {
        const slice = bytes.subarray(no * chunkSize, (no + 1) * chunkSize);
        const r = await hubPost(body, { action: 'chunk', upload_id: uploadId, chunk_no: no, sha: crypto.createHash('sha256').update(slice).digest('hex'), data: slice.toString('base64') });
        if (r.status !== 200) return NextResponse.json({ ok: false, stage: 'upload', sent, chunks: total, resumable: true, upload_id: uploadId, ...r.json }, { status: r.status });
        sent++;
      }

      // 3. The hub assembles, validates, stages, verifies and only then activates.
      const commit = await hubPost(body, { action: 'commit', upload_id: uploadId });
      if (commit.status !== 200) return NextResponse.json({ ok: false, stage: commit.json?.stage || 'commit', chunks_sent: sent, resumable: commit.json?.code === 'INCOMPLETE_UPLOAD', upload_id: uploadId, ...commit.json }, { status: commit.status });

      // 4. Both sides now hold the same records: the journal is settled and the cursor realigned.
      const realigned = realignAfterClone(local, readIdentity(local));
      return NextResponse.json({ ok: true, stage: 'verified', direction, chunks_sent: sent, chunks: total, size: bytes.length, sha, source: source.fingerprint, hub: commit.json, cursor: realigned.watermark, message: commit.json?.message || 'The online copy now matches this device.' });
    }

    // ---- pull: online → offline ----------------------------------------------------------------
    const manifest = await hubGet(body, 'manifest');
    if (!manifest || manifest.error) return NextResponse.json({ ok: false, stage: 'manifest', error: manifest?.error || 'The online snapshot could not be described.' }, { status: 502 });
    if (manifest.ok === false) return NextResponse.json({ ok: false, stage: 'validate-source', error: 'The online database did not pass validation, so nothing was downloaded.', checks: manifest.checks }, { status: 422 });

    const localFile = databasePath(mode as Mode, companyId);
    if (preview) {
      const here = validateDatabaseFile(snapshotToFile(local, path.join(dir, 'local.db')));
      const differences = here.fingerprint && manifest.fingerprint ? compareFingerprints(manifest.fingerprint, here.fingerprint).differences : [];
      return NextResponse.json({ ok: true, stage: 'preview', direction, size: manifest.size, sha: manifest.sha, fingerprint: manifest.fingerprint, local: here.fingerprint, differences, confirmation_required: expected, message: `${manifest.fingerprint?.business_rows ?? '?'} records across ${Object.keys(manifest.fingerprint?.tables || {}).length} tables (${(Number(manifest.size) / 1024).toFixed(0)} KB) would replace this device's copy of "${organizationName}" (${mode}). ${differences.length} difference(s) from what is here now. The current file is kept for rollback.` });
    }

    // 1. Download in chunks, retrying a chunk that does not arrive intact.
    const chunks = Number(manifest.chunks || 0);
    const parts: Buffer[] = [];
    for (let no = 0; no < chunks; no++) {
      let got: Buffer | null = null;
      for (let attempt = 0; attempt < DOWNLOAD_RETRIES && !got; attempt++) {
        const r = await hubGet(body, 'chunk', { no: String(no) });
        if (!r || r.error || typeof r.data !== 'string') continue;
        const buf = Buffer.from(r.data, 'base64');
        if (r.sha && crypto.createHash('sha256').update(buf).digest('hex') !== r.sha) continue;
        got = buf;
      }
      if (!got) return NextResponse.json({ ok: false, stage: 'download', error: `Chunk ${no} of ${chunks} could not be downloaded intact after ${DOWNLOAD_RETRIES} attempts. Nothing on this device was changed; run the clone again to resume.`, received: parts.length, chunks }, { status: 502 });
      parts.push(got);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== Number(manifest.size) || crypto.createHash('sha256').update(bytes).digest('hex') !== String(manifest.sha)) {
      return NextResponse.json({ ok: false, stage: 'verify-download', error: 'The downloaded copy does not match the online checksum, so this device was not changed.' }, { status: 422 });
    }

    // 2. Validate the download before it is allowed anywhere near the live file.
    const incoming = path.join(dir, 'incoming.db');
    fs.writeFileSync(incoming, bytes);
    const source = validateDatabaseFile(incoming);
    if (!source.ok || !source.fingerprint) return NextResponse.json({ ok: false, stage: 'validate-download', error: `The downloaded copy did not pass validation, so this device was not changed: ${source.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`, checks: source.checks }, { status: 422 });

    // 3. Atomic local activation, keeping the previous file, then verify what is now live.
    const identity = readIdentity(local);
    closeDatabase(mode as Mode, companyId);
    const backup = `${localFile}.pre-clone-${Date.now()}.db`;
    if (fs.existsSync(localFile)) {
      fs.copyFileSync(localFile, backup);
      for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(localFile + suffix); } catch { /* not present */ } }
    }
    const staged = `${localFile}.incoming-${Date.now()}.db`;
    fs.writeFileSync(staged, bytes);
    fs.renameSync(staged, localFile);
    const after = validateDatabaseFile(localFile);
    const comparison = after.fingerprint ? compareFingerprints(source.fingerprint, after.fingerprint) : { ok: false, differences: [] };
    if (!after.ok || !comparison.ok) {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, localFile);
      return NextResponse.json({ ok: false, stage: 'verify-activated', error: 'The replaced local database did not verify, so the previous file was restored.', checks: after.checks, differences: comparison.differences }, { status: 422 });
    }

    // 4. Keep this device's own identity and settle the journal.
    const reopened = db(mode as Mode, companyId);
    const realigned = realignAfterClone(reopened, identity);
    return NextResponse.json({ ok: true, stage: 'verified', direction, size: bytes.length, sha: String(manifest.sha), source: source.fingerprint, destination: after.fingerprint, cursor: realigned.watermark, previous_file: path.basename(backup), message: `This device now holds the online copy of "${organizationName}" (${mode}): ${source.fingerprint.business_rows} records across ${Object.keys(source.fingerprint.tables).length} tables, verified table by table and against every financial total. The previous file is kept as ${path.basename(backup)}.` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'The clone failed.' }, { status: 502 });
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
}

function readIdentity(d: any) {
  const row = d.prepare('SELECT device_id,paired_url,paired_company_id,sync_mode,remote_device_id FROM sync_meta WHERE id=1').get() as any;
  return { device_id: String(row?.device_id || ''), paired_url: row?.paired_url ?? null, paired_company_id: row?.paired_company_id ?? null, sync_mode: row?.sync_mode ?? null, remote_device_id: row?.remote_device_id ?? null };
}

function hubHeaders(body: any) {
  const token = String(body.device_token || '');
  const remoteCompanyId = Number(body.remote_company_id || 0);
  const mode = String(body.remote_mode || body.mode || 'LIVE');
  if (!token || token.length > 300 || !remoteCompanyId) throw new Error('The online URL, destination organization and pairing token are required.');
  return { 'content-type': 'application/json', 'x-solivy-device-token': token, 'x-solivy-device-id': String(body.device_id || ''), 'x-aksh-company-id': String(remoteCompanyId), 'x-aksh-mode': mode };
}

async function hubGet(body: any, action: string, extra: Record<string, string> = {}) {
  const base = safeRemote(String(body.remote_url || ''));
  const query = new URLSearchParams({ action, ...extra }).toString();
  const r = await fetch(`${base}/api/sync/clone?${query}`, { headers: hubHeaders(body), cache: 'no-store' });
  const json: any = await r.json().catch(() => ({ error: `The online site returned a non-JSON response (HTTP ${r.status}).` }));
  if (!r.ok && !json.error) json.error = `The online site refused the request (HTTP ${r.status}).`;
  return json;
}

async function hubPost(body: any, payload: any) {
  const base = safeRemote(String(body.remote_url || ''));
  const r = await fetch(`${base}/api/sync/clone`, { method: 'POST', headers: hubHeaders(body), body: JSON.stringify(payload), cache: 'no-store' });
  const json: any = await r.json().catch(() => ({ error: `The online site returned a non-JSON response (HTTP ${r.status}).` }));
  return { status: r.status, json };
}

const __wrapped_POST = withPostgresSQLiteBridge(handler, { noRetry: true });
export async function POST(req: Request) { return __wrapped_POST(req); }
