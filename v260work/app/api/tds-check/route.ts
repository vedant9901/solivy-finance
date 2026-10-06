import { NextResponse } from 'next/server';
import { db, Mode } from '../../../lib/db';
import { n } from '../../../lib/utils';
import { decideTds } from '../../../lib/tds';

export async function POST(req: Request) {
  try {
    const x = await req.json();
    const mode = (x.db_mode || x.mode || 'LIVE') as Mode;
    const companyId = Number(req.headers.get('x-aksh-company-id') || x.company_id || 1);
    const d=await db(mode, companyId);
    const party = await d.prepare('SELECT * FROM parties WHERE id=?').get(Number(x.party_id)) as any;
    if (!party) throw Error('Party not found');
    const decision = await decideTds(d, party, String(x.payment_date || new Date().toISOString().slice(0,10)), n(x.amount));
    return NextResponse.json({ ok: true, decision });
  } catch (e:any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
