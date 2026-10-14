import { NextResponse } from 'next/server';
import { db, sessionMode } from '../../../lib/db';

export const dynamic = 'force-dynamic';
const DEFAULTS: Record<string,string> = {
  purchase_account: 'Purchase Account',
  sales_account: 'Sales Account',
  output_cgst: 'Output CGST',
  output_sgst: 'Output SGST',
  output_igst: 'Output IGST',
  tds_payable: 'TDS Payable',
  interest_expense: 'Interest Expense',
  default_bank: 'Bank Account',
  default_cash: 'Cash',
};
function authorized(req: Request) {
  const role = req.headers.get('x-aksh-role');
  let menu: string[] = [];
  try { menu = JSON.parse(req.headers.get('x-aksh-menu') || '[]'); } catch {}
  if (role !== 'ADMIN' && !menu.includes('tally-export')) throw new Error('Tally Export access required');
}
function table(req: Request) {
  const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1));
  d.exec(`CREATE TABLE IF NOT EXISTS tally_ledger_mappings(mapping_key TEXT PRIMARY KEY,ledger_name TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  return d;
}
export async function GET(req: Request) {
  try {
    authorized(req); const d = table(req);
    const saved = d.prepare('SELECT mapping_key,ledger_name FROM tally_ledger_mappings').all() as any[];
    const mappings = { ...DEFAULTS };
    for (const row of saved) if (Object.prototype.hasOwnProperty.call(DEFAULTS, row.mapping_key)) mappings[row.mapping_key] = String(row.ledger_name);
    return NextResponse.json({ mappings, fields: Object.keys(DEFAULTS) });
  } catch (e: any) { return NextResponse.json({ error: e.message || 'Could not load Tally mappings' }, { status: 403 }); }
}
export async function POST(req: Request) {
  try {
    authorized(req); const body = await req.json(); const d = table(req);
    if (!body || typeof body.mappings !== 'object' || Array.isArray(body.mappings)) throw new Error('Provide a mappings object.');
    const save = d.prepare(`INSERT INTO tally_ledger_mappings(mapping_key,ledger_name,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(mapping_key) DO UPDATE SET ledger_name=excluded.ledger_name,updated_at=CURRENT_TIMESTAMP`);
    const tx = d.transaction(() => {
      for (const key of Object.keys(DEFAULTS)) {
        const value = String(body.mappings[key] ?? DEFAULTS[key]).trim();
        if (!value || value.length > 120) throw new Error(`Ledger name for ${key} must be 1–120 characters.`);
        save.run(key, value);
      }
    });
    tx(); return NextResponse.json({ ok: true, message: 'Tally ledger mappings saved for this company and environment.' });
  } catch (e: any) { return NextResponse.json({ error: e.message || 'Could not save Tally mappings' }, { status: 400 }); }
}
