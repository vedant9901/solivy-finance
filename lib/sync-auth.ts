import crypto from 'node:crypto';
import { adminDb, type Mode } from './db';

/**
 * Device-token authentication for the synchronisation endpoints (v2.9.0).
 *
 * Extracted from /api/sync/exchange so the clone endpoints authenticate exactly the same way: a
 * token hashed against admin.db `sync_devices`, scoped to one organization and one environment.
 * Two copies of this check would be two chances to diverge.
 */
export type SyncContext = { companyId: number; mode: Mode; deviceId: string };

export function syncTokenContext(req: Request): SyncContext {

  const token = String(req.headers.get('x-solivy-device-token') || '');
  const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
  const mode = String(req.headers.get('x-aksh-mode') || '');
  const deviceId = String(req.headers.get('x-solivy-device-id') || '');
  if (!token || token.length > 300 || !companyId || !['LIVE','TEST'].includes(mode) || !deviceId || deviceId.length > 100) throw new Error('Invalid sync device credentials.');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = adminDb().prepare('SELECT id,company_id,mode,active FROM sync_devices WHERE token_hash=?').get(hash) as any;
  if (!row || !row.active || Number(row.company_id)!==companyId || row.mode!==mode) throw new Error('Sync device is not authorized for this company/environment.');
  // Throttled: avoid rewriting admin.db (and its online snapshot) on every sync call.
  adminDb().prepare("UPDATE sync_devices SET last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND (last_seen_at IS NULL OR last_seen_at < datetime('now','-10 minutes'))").run(row.id);
  return {companyId,mode:mode as Mode,deviceId};
}
