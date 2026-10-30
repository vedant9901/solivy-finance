import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { db, sessionMode } from '../../../lib/db';
import { CHART } from '../../../lib/accounting/journal';

/** Budget targets per income/expense account per month. GET ?fy=2026-27 · POST {fy, lines:[{account_code, month:'2026-04', amount}]} */
const FY = /^\d{4}-\d{2}$/;
function monthsOf(fy: string) { const y = Number(fy.slice(0, 4)); return Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; return `${m >= 4 ? y : y + 1}-${String(m).padStart(2, '0')}`; }); }

async function getHandler(req: Request) {
  const fy = new URL(req.url).searchParams.get('fy') || '';
  if (!FY.test(fy)) return NextResponse.json({ error: 'Provide fy as YYYY-YY, e.g. 2026-27.' }, { status: 400 });
  const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1));
  const accounts = Object.values(CHART).filter((a) => a.group === 'INCOME' || a.group === 'EXPENSE').map((a) => ({ code: a.code, name: a.name, group: a.group }));
  return NextResponse.json({ fy, months: monthsOf(fy), accounts, lines: d.prepare('SELECT account_code, month, amount, notes, updated_by, updated_at FROM budgets WHERE fiscal_year=? ORDER BY account_code, month').all(fy) });
}
async function postHandler(req: Request) {
  try {
    const x = await req.json(); const fy = String(x.fy || '');
    if (!FY.test(fy)) throw new Error('Provide fy as YYYY-YY, e.g. 2026-27.');
    const months = new Set(monthsOf(fy));
    const lines = Array.isArray(x.lines) ? x.lines : [];
    if (!lines.length || lines.length > 1000) throw new Error('Provide between 1 and 1000 budget lines.');
    const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1)); const user = String(req.headers.get('x-aksh-user') || '');
    const up = d.prepare('INSERT INTO budgets(fiscal_year, account_code, month, amount, notes, updated_by, updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(fiscal_year, account_code, month) DO UPDATE SET amount=excluded.amount, notes=excluded.notes, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP');
    d.transaction(() => {
      for (const l of lines) {
        const acct = CHART[String(l.account_code)];
        if (!acct || (acct.group !== 'INCOME' && acct.group !== 'EXPENSE')) throw new Error(`Account ${l.account_code} cannot be budgeted.`);
        if (!months.has(String(l.month))) throw new Error(`Month ${l.month} is outside FY ${fy}.`);
        const amount = Number(l.amount); if (!Number.isFinite(amount) || amount < 0 || amount > 1e13) throw new Error('Budget amounts must be zero or positive.');
        up.run(fy, acct.code, String(l.month), Math.round(amount * 100) / 100, String(l.notes || '').slice(0, 200), user);
      }
    })();
    return NextResponse.json({ ok: true, saved: lines.length });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
}
export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge(getHandler); const __wrapped_POST = withPostgresSQLiteBridge(postHandler);
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
