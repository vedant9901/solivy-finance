import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Fingerprint } from './clone-engine';

/**
 * Durable state for clone operations (v2.9.0), in PostgreSQL rather than in memory.
 *
 * An upload that only existed in a process's memory could not survive the application restart or
 * the network interruption the brief requires it to survive, and a lock held in memory would not
 * stop a second clone started from another instance. Chunks are therefore written straight to
 * PostgreSQL as they arrive, keyed by (upload_id, chunk_no) so resending one is idempotent, and
 * the lock and the run log are rows other instances can see.
 *
 * They are kept out of admin.db deliberately: admin.db is itself a snapshot synchronised to
 * PostgreSQL, so megabytes of upload chunks passing through it would be uploaded twice.
 */
export const UPLOAD_TABLE = 'solivy_clone_uploads';
export const UPLOAD_CHUNK_TABLE = 'solivy_clone_upload_chunks';
export const RUN_TABLE = 'solivy_clone_runs';
export const LOCK_TABLE = 'solivy_clone_locks';

let ready = false;
export function resetCloneSchemaFlag() { ready = false; }

export async function ensureCloneSchema(client: PoolClient) {
  if (ready) return;
  await client.query(`CREATE TABLE IF NOT EXISTS ${UPLOAD_TABLE} (
    upload_id TEXT PRIMARY KEY, company_id INTEGER NOT NULL, mode TEXT NOT NULL, device_id TEXT NOT NULL,
    size_bytes BIGINT NOT NULL, sha256 TEXT NOT NULL, chunk_size INTEGER NOT NULL, fingerprint JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${UPLOAD_CHUNK_TABLE} (
    upload_id TEXT NOT NULL, chunk_no INTEGER NOT NULL, data BYTEA NOT NULL,
    PRIMARY KEY (upload_id, chunk_no))`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${RUN_TABLE} (
    id BIGSERIAL PRIMARY KEY, company_id INTEGER NOT NULL, mode TEXT NOT NULL, direction TEXT NOT NULL,
    ok BOOLEAN NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, device_id TEXT,
    source JSONB, destination JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (
    company_id INTEGER NOT NULL, mode TEXT NOT NULL, device_id TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (company_id, mode))`);
  // An abandoned clone must not block the organization for ever.
  await client.query(`DELETE FROM ${LOCK_TABLE} WHERE acquired_at < NOW() - INTERVAL '30 minutes'`);
  await client.query(`DELETE FROM ${UPLOAD_TABLE} WHERE created_at < NOW() - INTERVAL '2 days'`);
  await client.query(`DELETE FROM ${UPLOAD_CHUNK_TABLE} WHERE upload_id NOT IN (SELECT upload_id FROM ${UPLOAD_TABLE})`);
  ready = true;
}

export type Ctx = { companyId: number; mode: string; deviceId: string };

/** One clone at a time per organization and environment, across instances. */
export async function acquireCloneLock(client: PoolClient, ctx: Ctx) {
  const r = await client.query(
    `INSERT INTO ${LOCK_TABLE}(company_id, mode, device_id) VALUES($1,$2,$3)
     ON CONFLICT (company_id, mode) DO UPDATE SET device_id=EXCLUDED.device_id, acquired_at=NOW()
     WHERE ${LOCK_TABLE}.device_id=EXCLUDED.device_id OR ${LOCK_TABLE}.acquired_at < NOW() - INTERVAL '30 minutes'
     RETURNING device_id`, [ctx.companyId, ctx.mode, ctx.deviceId]);
  if (r.rowCount) return { ok: true as const, message: '' };
  const held = await client.query(`SELECT device_id, acquired_at FROM ${LOCK_TABLE} WHERE company_id=$1 AND mode=$2`, [ctx.companyId, ctx.mode]);
  const row = held.rows[0];
  return { ok: false as const, message: `Another clone of this organization and environment is already running (started ${row ? new Date(row.acquired_at).toISOString() : 'recently'}). Wait for it to finish, or retry in 30 minutes if it was interrupted.` };
}

export async function releaseCloneLock(client: PoolClient, ctx: Pick<Ctx, 'companyId' | 'mode'>) {
  await client.query(`DELETE FROM ${LOCK_TABLE} WHERE company_id=$1 AND mode=$2`, [ctx.companyId, ctx.mode]);
}

export async function beginUpload(client: PoolClient, ctx: Ctx, info: { size: number; sha: string; chunkSize: number; fingerprint: Fingerprint | null }) {
  // Deterministic in the sha and the device, so a restarted device resumes the same upload
  // instead of starting a second one and leaving the first half behind.
  const uploadId = 'up-' + crypto.createHash('sha256').update(`${ctx.companyId}:${ctx.mode}:${ctx.deviceId}:${info.sha}:${info.size}`).digest('hex').slice(0, 32);
  await client.query(
    `INSERT INTO ${UPLOAD_TABLE}(upload_id, company_id, mode, device_id, size_bytes, sha256, chunk_size, fingerprint)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (upload_id) DO UPDATE SET created_at=NOW()`,
    [uploadId, ctx.companyId, ctx.mode, ctx.deviceId, info.size, info.sha, info.chunkSize, info.fingerprint ? JSON.stringify(info.fingerprint) : null]);
  return uploadId;
}

async function uploadRow(client: PoolClient, uploadId: string, ctx: Ctx) {
  const r = await client.query(`SELECT * FROM ${UPLOAD_TABLE} WHERE upload_id=$1 AND company_id=$2 AND mode=$3`, [uploadId, ctx.companyId, ctx.mode]);
  return r.rows[0] || null;
}

export async function storeChunk(client: PoolClient, uploadId: string, ctx: Ctx, no: number, data: Buffer) {
  const row = await uploadRow(client, uploadId, ctx);
  if (!row) return { ok: false as const, message: 'That clone upload is not open for this organization and environment. Start it again.' };
  const chunks = Math.ceil(Number(row.size_bytes) / Number(row.chunk_size));
  if (no >= chunks) return { ok: false as const, message: `Chunk ${no} is past the end of the declared upload (${chunks} chunks).` };
  await client.query(`INSERT INTO ${UPLOAD_CHUNK_TABLE}(upload_id, chunk_no, data) VALUES($1,$2,$3)
    ON CONFLICT (upload_id, chunk_no) DO UPDATE SET data=EXCLUDED.data`, [uploadId, no, data]);
  const received = Number((await client.query(`SELECT COUNT(*) n FROM ${UPLOAD_CHUNK_TABLE} WHERE upload_id=$1`, [uploadId])).rows[0].n || 0);
  return { ok: true as const, received, chunks };
}

export async function uploadState(client: PoolClient, uploadId: string, ctx: Ctx) {
  const row = await uploadRow(client, uploadId, ctx);
  if (!row) return { ok: false as const, message: 'That clone upload is not open.' };
  const chunks = Math.ceil(Number(row.size_bytes) / Number(row.chunk_size));
  const have = new Set((await client.query(`SELECT chunk_no FROM ${UPLOAD_CHUNK_TABLE} WHERE upload_id=$1`, [uploadId])).rows.map((x: any) => Number(x.chunk_no)));
  const missing: number[] = [];
  for (let i = 0; i < chunks; i++) if (!have.has(i)) missing.push(i);
  return { ok: true as const, upload_id: uploadId, size: Number(row.size_bytes), sha: String(row.sha256), chunk_size: Number(row.chunk_size), chunks, received: have.size, missing: missing.slice(0, 500), complete: missing.length === 0 };
}

export async function assembleUpload(client: PoolClient, uploadId: string, ctx: Ctx) {
  const row = await uploadRow(client, uploadId, ctx);
  if (!row) return { ok: false as const, message: 'That clone upload is not open.', missing: [] as number[] };
  const state = await uploadState(client, uploadId, ctx);
  if (!state.ok) return { ok: false as const, message: state.message, missing: [] as number[] };
  if (!state.complete) return { ok: false as const, message: `The upload is incomplete: ${state.chunks - state.received} of ${state.chunks} chunks are still missing. Send them and commit again — nothing was activated.`, missing: state.missing };
  const parts = (await client.query(`SELECT chunk_no, data FROM ${UPLOAD_CHUNK_TABLE} WHERE upload_id=$1 ORDER BY chunk_no`, [uploadId])).rows;
  const bytes = Buffer.concat(parts.map((p: any) => p.data as Buffer));
  if (bytes.length !== Number(row.size_bytes)) return { ok: false as const, message: `The assembled upload is ${bytes.length} bytes but ${row.size_bytes} were declared. Nothing was activated.`, missing: [] as number[] };
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha !== String(row.sha256)) return { ok: false as const, message: 'The assembled upload does not match the checksum the device declared, so nothing was activated. Start the upload again.', missing: [] as number[] };
  let declaredFingerprint: Fingerprint | null = null;
  try { declaredFingerprint = row.fingerprint ? (typeof row.fingerprint === 'string' ? JSON.parse(row.fingerprint) : row.fingerprint) : null; } catch { declaredFingerprint = null; }
  return { ok: true as const, bytes, declaredFingerprint, message: '', missing: [] as number[] };
}

export async function clearUpload(client: PoolClient, uploadId: string) {
  await client.query(`DELETE FROM ${UPLOAD_CHUNK_TABLE} WHERE upload_id=$1`, [uploadId]);
  await client.query(`DELETE FROM ${UPLOAD_TABLE} WHERE upload_id=$1`, [uploadId]);
}

export async function recordRun(client: PoolClient, run: { companyId: number; mode: string; direction: string; ok: boolean; stage: string; message: string; deviceId?: string; source?: any; destination?: any }) {
  await client.query(
    `INSERT INTO ${RUN_TABLE}(company_id, mode, direction, ok, stage, message, device_id, source, destination)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [run.companyId, run.mode, run.direction, run.ok, run.stage, String(run.message || '').slice(0, 4000), run.deviceId || null,
      run.source ? JSON.stringify(run.source) : null, run.destination ? JSON.stringify(run.destination) : null]);
}

export async function cloneRuns(client: PoolClient, companyId: number, mode: string, limit = 10) {
  const r = await client.query(
    `SELECT id, direction, ok, stage, message, device_id, created_at,
            (source->>'business_rows')::bigint AS source_rows, (destination->>'business_rows')::bigint AS destination_rows
     FROM ${RUN_TABLE} WHERE company_id=$1 AND mode=$2 ORDER BY id DESC LIMIT $3`, [companyId, mode, Math.min(50, Math.max(1, limit))]);
  return r.rows;
}

export async function lastRun(client: PoolClient, companyId: number, mode: string) {
  return (await cloneRuns(client, companyId, mode, 1))[0] || null;
}
