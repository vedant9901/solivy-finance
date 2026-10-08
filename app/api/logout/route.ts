import { NextResponse } from 'next/server';
import { COOKIE, cookieOptions } from '../../../lib/session';

export async function POST(req: Request) {
  const r = NextResponse.json({ ok: true });
  r.cookies.set(COOKIE, '', { ...cookieOptions(req), maxAge: 0 });
  return r;
}
