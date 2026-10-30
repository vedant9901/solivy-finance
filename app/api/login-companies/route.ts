import { NextResponse } from 'next/server';
import { withPostgresSQLiteBridge, bridgeIsOnline } from '../../../lib/postgres-sqlite-bridge';
import { postgresPool, usesPostgres } from '../../../lib/postgres';
import { readLoginCompanies } from '../../../lib/public-projection';
import { adminDb } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' };

/** Fallback: read the list from admin.db (hydrating it) and let the bridge refresh the projection. */
async function __bridge_GET(_req: Request) {
  try {
    const companies = adminDb().prepare('SELECT id, name, code FROM companies WHERE active = 1 ORDER BY name').all();
    return NextResponse.json({ companies }, { headers: HEADERS });
  } catch (error: unknown) {
    console.error('GET /api/login-companies failed:', error);
    return NextResponse.json({ error: 'Unable to load companies. Check DATABASE_URL and the SOLIVY database bridge.' }, { status: 500 });
  }
}

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET, { scope: 'admin' });

export async function GET(req: Request) {
  // The sign-in screen is public: serve it from the small projection row instead of downloading
  // the whole admin.db snapshot (measured 801 KB of Neon transfer per visit before v2.7.1).
  if (bridgeIsOnline() && usesPostgres()) {
    const client = await postgresPool().connect();
    try {
      const companies = await readLoginCompanies(client);
      if (companies) return NextResponse.json({ companies }, { headers: HEADERS });
    } catch (error) { console.error('login companies projection unavailable', error); }
    finally { client.release(); }
  }
  return __wrapped_GET(req);
}
