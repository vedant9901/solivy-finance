import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { PoolClient } from 'pg';

/**
 * PostgreSQL storage for SQLite snapshot files (online mode).
 *
 * Format v2 ("chunked"), v2.7.1:
 *  - the file is split into `chunk_size` chunks (4 KiB = one SQLite page since v2.7.1, so a write
 *    uploads only the pages SQLite actually dirtied) stored in solivy_sqlite_chunks, each
 *    identified by a content hash; the snapshot row keeps the version, whole-file SHA-256, size,
 *    chunk size and the ordered manifest. A write uploads only changed chunks, batched into one
 *    statement per group.
 *  - db_file keeps a whole-file BASE BLOB for a (possibly older) version, with its own manifest.
 *    Small chunks compress worse individually, so an instance with no local copy downloads the
 *    base blob (one row, compressed as a whole) plus the chunks that changed after it — measured
 *    on a 1.9 MB organization file: 233 KB vs 570 KB for 4 KiB chunks alone. The blob is rebuilt
 *    only when enough chunks have diverged (BASE_REFRESH_RATIO), so ordinary writes stay cheap.
 *  - compression is Brotli (quality 5) since v2.7.1, with a one-byte codec tag; gzip rows written
 *    by v2.7.0 are still read. Measured on the same file: Brotli chunks 428 KB vs gzip 478 KB.
 *  - bytes move as base64 text: pg-protocol 1.10.3 corrupts binary bytea results.
 *
 * Format v1 (legacy, v2.6.30 and earlier): the whole raw SQLite file in db_file with no manifest.
 * Still readable; converted on the next write.
 *
 * Every assembled file is verified against the stored SHA-256 and re-downloaded in full on
 * mismatch, so a stale or truncated base can never be handed to SQLite.
 */
export const CHUNK_SIZE = 4 * 1024;
export const SNAPSHOT_TABLE = 'solivy_sqlite_snapshots';
export const CHUNK_TABLE = 'solivy_sqlite_chunks';
export const BACKUP_TABLE = 'solivy_sqlite_snapshot_backups';
/** Rebuild the whole-file base blob once this share of chunks differs from it. */
const BASE_REFRESH_RATIO = 0.2;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const BROTLI_TAG = 0x02;
const BROTLI = (b: Buffer) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } });

/** Compress for storage: one-byte codec tag + payload. */
export function encodeBlob(bytes: Buffer): Buffer { return Buffer.concat([Buffer.from([BROTLI_TAG]), BROTLI(bytes)]); }
/** Decompress storage bytes written by any released version (raw, gzip or tagged Brotli). */
export function decodeBlob(stored: Buffer): Buffer {
  if (stored.length >= 2 && stored.subarray(0, 2).equals(GZIP_MAGIC)) return zlib.gunzipSync(stored);
  if (stored.length >= 1 && stored[0] === BROTLI_TAG) return zlib.brotliDecompressSync(stored.subarray(1));
  return stored; // v2.6.30 raw SQLite file
}
export const decodeLegacy = decodeBlob;

export const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const chunkHash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
/** The manifest is stored compressed: as plain text it was 19 KB of protocol traffic per read of a 3 MB file. */
const packManifest = (m: string[]) => encodeBlob(Buffer.from(m.join(','), 'utf8'));
const unpackManifest = (stored: Buffer) => decodeBlob(stored).toString('utf8').split(',').filter(Boolean);
export function manifestOf(file: Buffer, chunkSize: number = CHUNK_SIZE): string[] {
  const out: string[] = [];
  for (let i = 0; i < file.length; i += chunkSize) out.push(chunkHash(file.subarray(i, i + chunkSize)));
  return out;
}

export type LocalCopy = { version: string; sha: string; manifest: string[]; chunkSize: number; chunksSinceBase?: number };
export type Remote = { version: string; sha: string | null; size: number; manifest: string[] | null; chunkSize: number; baseBytes: number; baseVersion: string; chunksSinceBase: number };
export const transferStats = { bytesDown: 0, bytesUp: 0, chunksDown: 0, chunksUp: 0, fullDownloads: 0, baseDownloads: 0 };
export function resetTransferStats() { transferStats.bytesDown = 0; transferStats.bytesUp = 0; transferStats.chunksDown = 0; transferStats.chunksUp = 0; transferStats.fullDownloads = 0; transferStats.baseDownloads = 0; }

let ready = false;
export async function ensureTables(client: PoolClient) {
  if (ready) return;
  await client.query(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (db_key TEXT PRIMARY KEY, db_file BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`ALTER TABLE ${SNAPSHOT_TABLE} ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 TEXT, ADD COLUMN IF NOT EXISTS format SMALLINT NOT NULL DEFAULT 1, ADD COLUMN IF NOT EXISTS size_bytes BIGINT, ADD COLUMN IF NOT EXISTS manifest TEXT, ADD COLUMN IF NOT EXISTS chunk_size INTEGER, ADD COLUMN IF NOT EXISTS base_manifest TEXT, ADD COLUMN IF NOT EXISTS manifest_z BYTEA, ADD COLUMN IF NOT EXISTS base_version BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS chunks_since_base INTEGER NOT NULL DEFAULT 0`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${CHUNK_TABLE} (db_key TEXT NOT NULL, chunk_no INTEGER NOT NULL, hash TEXT NOT NULL, data BYTEA NOT NULL, PRIMARY KEY (db_key, chunk_no))`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (id BIGSERIAL PRIMARY KEY, db_key TEXT NOT NULL, reason TEXT NOT NULL, db_file BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS solivy_login_attempts (rate_key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, reset_at BIGINT NOT NULL, blocked_until BIGINT NOT NULL DEFAULT 0)`);
  ready = true;
}
export function resetReadyFlag() { ready = false; }

/** One small round trip: current version of each key (no file data). */
export async function remoteVersions(client: PoolClient, keys: string[]) {
  const r = await client.query(`SELECT db_key, version::text AS version FROM ${SNAPSHOT_TABLE} WHERE db_key = ANY($1)`, [keys]);
  return new Map<string, string>(r.rows.map((x: any) => [x.db_key, String(x.version)]));
}

async function remoteDetails(client: PoolClient, keys: string[]): Promise<Map<string, Remote>> {
  const r = await client.query(`SELECT db_key, version::text AS version, sha256, format, size_bytes::text AS size, manifest, encode(manifest_z,'base64') AS manifest_z, chunk_size, octet_length(db_file) AS base_bytes, base_version::text AS base_version, chunks_since_base FROM ${SNAPSHOT_TABLE} WHERE db_key = ANY($1)`, [keys]);
  return new Map(r.rows.map((x: any) => {
    let manifest: string[] | null = null;
    if (Number(x.format) === 2) {
      if (x.manifest_z) manifest = unpackManifest(Buffer.from(String(x.manifest_z).replace(/\s+/g, ''), 'base64'));
      else if (x.manifest) manifest = String(x.manifest).split(',');
    }
    return [x.db_key, {
      version: String(x.version), sha: x.sha256, size: Number(x.size || 0), manifest,
      chunkSize: Number(x.chunk_size) > 0 ? Number(x.chunk_size) : 16 * 1024,
      baseBytes: Number(x.base_bytes || 0), baseVersion: String(x.base_version || '0'), chunksSinceBase: Number(x.chunks_since_base || 0),
    }];
  }));
}

/**
 * Bring each local file up to the current remote version, downloading as little as possible:
 * matching chunks of an older local copy are reused; otherwise the base blob plus the chunks that
 * changed after it; otherwise every chunk.
 */
export async function materialize(client: PoolClient, items: Array<{ key: string; file: string; local?: LocalCopy }>): Promise<Map<string, LocalCopy | null>> {
  const out = new Map<string, LocalCopy | null>();
  if (!items.length) return out;
  const details = await remoteDetails(client, items.map((i) => i.key));
  for (const it of items) {
    const r = details.get(it.key);
    fs.mkdirSync(path.dirname(it.file), { recursive: true });
    if (!r) { try { fs.unlinkSync(it.file); } catch {} out.set(it.key, null); continue; }
    if (!r.manifest) {
      // v1 legacy row: the whole file lives in db_file.
      const q = await client.query(`SELECT encode(db_file, 'base64') AS b64 FROM ${SNAPSHOT_TABLE} WHERE db_key=$1`, [it.key]);
      const stored = Buffer.from(String(q.rows[0].b64).replace(/\s+/g, ''), 'base64');
      transferStats.bytesDown += stored.length; transferStats.fullDownloads++;
      const bytes = decodeBlob(stored);
      fs.writeFileSync(it.file, bytes);
      out.set(it.key, { version: r.version, sha: sha256(bytes), manifest: manifestOf(bytes, r.chunkSize), chunkSize: r.chunkSize, chunksSinceBase: Number.MAX_SAFE_INTEGER });
      continue;
    }
    // Start from the best available base: this instance's own copy, else the stored base blob.
    let base: Buffer = Buffer.alloc(0); let baseManifest: string[] = [];
    if (it.local && fs.existsSync(it.file)) { base = fs.readFileSync(it.file); baseManifest = manifestOf(base, r.chunkSize); }
    const localShare = baseManifest.length ? r.manifest.filter((h, i) => baseManifest[i] === h).length / r.manifest.length : 0;
    if (localShare < 0.5 && r.baseBytes > 0) {
      const q = await client.query(`SELECT encode(db_file, 'base64') AS b64 FROM ${SNAPSHOT_TABLE} WHERE db_key=$1`, [it.key]);
      const stored = Buffer.from(String(q.rows[0].b64).replace(/\s+/g, ''), 'base64');
      if (stored.length) {
        // The blob is a base to diff against, never trusted as the answer: its chunk hashes are
        // computed here, every differing chunk is fetched, and the result is SHA-256 verified.
        try {
          const blob = decodeBlob(stored);
          const blobManifest = manifestOf(blob, r.chunkSize);
          const shared = r.manifest.filter((h, i) => blobManifest[i] === h).length;
          if (shared > 0) { base = blob; baseManifest = blobManifest; transferStats.bytesDown += stored.length; transferStats.baseDownloads++; }
        } catch (error) { if (process.env.SOLIVY_BRIDGE_DEBUG) console.error('[bridge] base blob unusable', it.key, error); }
      }
    }
    const missing: number[] = [];
    r.manifest.forEach((h, i) => { if (baseManifest[i] !== h) missing.push(i); });
    const assembled = Buffer.alloc(r.size);
    base.copy(assembled, 0, 0, Math.min(base.length, r.size));
    if (process.env.SOLIVY_BRIDGE_DEBUG) console.error(`[bridge] ${it.key} v${it.local?.version}->v${r.version} fetch ${missing.length}/${r.manifest.length} chunks`);
    const fetched = await fetchChunks(client, it.key, missing);
    for (const [i, data] of fetched) data.copy(assembled, i * r.chunkSize);
    let finalBytes = assembled;
    if (r.sha && sha256(finalBytes) !== r.sha) {
      // The base was not what we assumed: fall back to a full chunk download.
      const all = await fetchChunks(client, it.key, r.manifest.map((_, i) => i));
      finalBytes = Buffer.alloc(r.size);
      for (const [i, data] of all) data.copy(finalBytes, i * r.chunkSize);
      transferStats.fullDownloads++;
      if (sha256(finalBytes) !== r.sha) throw new Error(`Snapshot ${it.key} failed integrity verification. Restore from ${BACKUP_TABLE}.`);
    }
    fs.writeFileSync(it.file, finalBytes);
    out.set(it.key, { version: r.version, sha: r.sha || sha256(finalBytes), manifest: r.manifest, chunkSize: r.chunkSize, chunksSinceBase: r.chunksSinceBase });
  }
  return out;
}

async function fetchChunks(client: PoolClient, key: string, chunkNos: number[]) {
  const map = new Map<number, Buffer>();
  if (!chunkNos.length) return map;
  const r = await client.query(`SELECT chunk_no, encode(data, 'base64') AS b64 FROM ${CHUNK_TABLE} WHERE db_key=$1 AND chunk_no = ANY($2)`, [key, chunkNos]);
  for (const row of r.rows as any[]) {
    const stored = Buffer.from(String(row.b64).replace(/\s+/g, ''), 'base64');
    transferStats.bytesDown += stored.length; transferStats.chunksDown++;
    map.set(Number(row.chunk_no), decodeBlob(stored));
  }
  if (map.size !== chunkNos.length) throw new Error(`Snapshot ${key} is missing ${chunkNos.length - map.size} chunk(s).`);
  return map;
}

/**
 * Write a file as the next version. `prev` is what this request materialised (null = new key).
 * Uploads only the chunks whose hash differs from prev.manifest, and refreshes the whole-file base
 * blob when it has drifted far enough to make cold reads expensive. Must run inside a transaction.
 * Returns the new version, or null when the optimistic version check failed (nothing was written).
 */
export async function writeSnapshot(client: PoolClient, key: string, bytes: Buffer, prev: LocalCopy | null): Promise<LocalCopy | null> {
  const manifest = manifestOf(bytes, CHUNK_SIZE);
  const sha = sha256(bytes);
  // A chunk size change (v2.7.0 → v2.7.1) or a legacy row means every chunk must be re-uploaded.
  const resized = Boolean(prev && prev.chunkSize !== CHUNK_SIZE);
  const prevManifest = resized ? [] : (prev?.manifest || []);
  const changed: number[] = [];
  for (let i = 0; i < manifest.length; i++) if (resized || prevManifest[i] !== manifest[i]) changed.push(i);
  // Blob freshness is tracked as "chunks written since the blob" in the row itself, so a write
  // never has to download a manifest to decide (that cost 19 KB of protocol traffic per write).
  const driftSoFar = Number(prev?.chunksSinceBase ?? Number.MAX_SAFE_INTEGER);
  const refreshBase = resized || !prev || driftSoFar + changed.length > Math.max(8, manifest.length * BASE_REFRESH_RATIO);
  const baseBlob = refreshBase ? encodeBlob(bytes) : null;
  if (baseBlob) transferStats.bytesUp += baseBlob.length;

  const manifestZ = packManifest(manifest);
  transferStats.bytesUp += manifestZ.length;
  let row;
  if (!prev) {
    row = await client.query(
      `INSERT INTO ${SNAPSHOT_TABLE}(db_key, db_file, version, sha256, format, size_bytes, manifest, manifest_z, chunk_size, base_version, chunks_since_base, updated_at)
       VALUES($1, $2, 1, $3, 2, $4, NULL, $5, $6, 1, 0, NOW()) ON CONFLICT (db_key) DO NOTHING RETURNING version::text AS version`,
      [key, baseBlob ?? Buffer.alloc(0), sha, bytes.length, manifestZ, CHUNK_SIZE]);
  } else if (baseBlob) {
    row = await client.query(
      `UPDATE ${SNAPSHOT_TABLE} SET db_file=$2, version=version+1, sha256=$3, format=2, size_bytes=$4, manifest=NULL, manifest_z=$5, chunk_size=$6, base_version=version+1, base_manifest=NULL, chunks_since_base=0, updated_at=NOW()
       WHERE db_key=$1 AND version=$7 RETURNING version::text AS version`,
      [key, baseBlob, sha, bytes.length, manifestZ, CHUNK_SIZE, prev.version]);
  } else {
    row = await client.query(
      `UPDATE ${SNAPSHOT_TABLE} SET version=version+1, sha256=$2, format=2, size_bytes=$3, manifest=NULL, manifest_z=$4, chunk_size=$5, chunks_since_base=chunks_since_base+$6, updated_at=NOW()
       WHERE db_key=$1 AND version=$7 RETURNING version::text AS version`,
      [key, sha, bytes.length, manifestZ, CHUNK_SIZE, changed.length, prev.version]);
  }
  if (!row.rowCount) return null;
  // A converted legacy row has no chunk rows yet: upload all of them once.
  const noChunks = prev && (await client.query(`SELECT 1 FROM ${CHUNK_TABLE} WHERE db_key=$1 LIMIT 1`, [key])).rowCount === 0;
  const upload: number[] = noChunks ? manifest.map((_, i) => i) : changed;
  for (let g = 0; g < upload.length; g += 64) {
    const group = upload.slice(g, g + 64);
    const datas = group.map((i) => encodeBlob(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)));
    for (const d of datas) { transferStats.bytesUp += d.length; transferStats.chunksUp++; }
    await client.query(
      `INSERT INTO ${CHUNK_TABLE}(db_key, chunk_no, hash, data)
       SELECT $1, n, h, d FROM unnest($2::int[], $3::text[], $4::bytea[]) AS t(n, h, d)
       ON CONFLICT (db_key, chunk_no) DO UPDATE SET hash=EXCLUDED.hash, data=EXCLUDED.data`,
      [key, group, group.map((i) => manifest[i]), datas]);
  }
  if (prevManifest.length > manifest.length || resized || noChunks) await client.query(`DELETE FROM ${CHUNK_TABLE} WHERE db_key=$1 AND chunk_no >= $2`, [key, manifest.length]);
  return { version: String(row.rows[0].version), sha, manifest, chunkSize: CHUNK_SIZE, chunksSinceBase: baseBlob ? 0 : driftSoFar + changed.length };
}

export async function backupSnapshot(client: PoolClient, key: string, bytes: Buffer, reason: string) {
  await client.query(`INSERT INTO ${BACKUP_TABLE}(db_key, reason, db_file) VALUES($1,$2,$3)`, [key, reason, encodeBlob(bytes)]);
}
