import { NextResponse } from 'next/server';
import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { adminDb } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function __bridge_GET(_req: Request) {
  try {
    const d = adminDb();
    const companies = d.prepare('SELECT id, name, code FROM companies WHERE active = 1 ORDER BY name').all();
    return NextResponse.json({ companies });
  } catch (error: unknown) {
    console.error('GET /api/login-companies failed:', error);
    return NextResponse.json({ error: 'Unable to load companies. Check DATABASE_URL and the SOLIVY database bridge.' }, { status: 500 });
  }
}

const __wrapped_GET = withPostgresSQLiteBridge(__bridge_GET);
export async function GET(req: Request) { return __wrapped_GET(req); }
