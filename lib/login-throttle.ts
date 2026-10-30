import { adminDb } from './db';
import { postgresPool, usesPostgres } from './postgres';

/**
 * Login throttling shared by every server instance:
 *  - online: PostgreSQL table solivy_login_attempts (no admin.db snapshot write per attempt)
 *  - local:  admin.db login_attempts
 * Policy: 5 failures in 10 min → 2 min block; 10 → 15 min; 20+ → 60 min.
 * The key includes the client IP only when TRUST_PROXY_HEADERS=true (otherwise IPs are
 * spoofable); without a trusted proxy the limit is per username.
 */
const WINDOW_MS = 10 * 60 * 1000;
function blockFor(count: number) { return count >= 20 ? 60 * 60 * 1000 : count >= 10 ? 15 * 60 * 1000 : count >= 5 ? 2 * 60 * 1000 : 0; }
const online = () => process.env.SOLIVY_SQLITE_BRIDGE === '1' && usesPostgres();

type State = { count: number; reset_at: number; blocked_until: number };
async function read(key: string): Promise<State | null> {
  if (online()) { const r = await postgresPool().query('SELECT count, reset_at::text, blocked_until::text FROM solivy_login_attempts WHERE rate_key=$1', [key]); return r.rows[0] ? { count: Number(r.rows[0].count), reset_at: Number(r.rows[0].reset_at), blocked_until: Number(r.rows[0].blocked_until) } : null; }
  return (adminDb().prepare('SELECT count, reset_at, blocked_until FROM login_attempts WHERE rate_key=?').get(key) as State) || null;
}
async function write(key: string, s: State) {
  if (online()) { await postgresPool().query('INSERT INTO solivy_login_attempts(rate_key,count,reset_at,blocked_until) VALUES($1,$2,$3,$4) ON CONFLICT (rate_key) DO UPDATE SET count=EXCLUDED.count, reset_at=EXCLUDED.reset_at, blocked_until=EXCLUDED.blocked_until', [key, s.count, s.reset_at, s.blocked_until]); return; }
  adminDb().prepare('INSERT INTO login_attempts(rate_key,count,reset_at,blocked_until) VALUES(?,?,?,?) ON CONFLICT(rate_key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at, blocked_until=excluded.blocked_until').run(key, s.count, s.reset_at, s.blocked_until);
}
async function remove(key: string) {
  if (online()) { await postgresPool().query('DELETE FROM solivy_login_attempts WHERE rate_key=$1', [key]); return; }
  adminDb().prepare('DELETE FROM login_attempts WHERE rate_key=?').run(key);
}

export async function checkThrottle(key: string, now = Date.now()) {
  const s = await read(key);
  if (s && s.blocked_until > now) return { allowed: false, retryAfter: Math.ceil((s.blocked_until - now) / 1000) };
  return { allowed: true, retryAfter: 0 };
}
export async function recordFailure(key: string, now = Date.now()) {
  const prev = await read(key);
  const s: State = prev && now <= prev.reset_at ? { ...prev } : { count: 0, reset_at: now + WINDOW_MS, blocked_until: 0 };
  s.count += 1;
  const block = blockFor(s.count);
  if (block) { s.blocked_until = now + block; s.reset_at = Math.max(s.reset_at, s.blocked_until + WINDOW_MS); }
  await write(key, s);
}
export async function clearFailures(key: string) { if ((await read(key))) await remove(key); }
