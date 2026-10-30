import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { db, adminDb, sessionMode } from '../../../../lib/db';
import { buildJournal, type Journal } from '../../../../lib/accounting/journal';
import { trialBalance, balanceSheet, incomeStatement } from '../../../../lib/accounting/statements';
import { financialYear } from '../../../../lib/money';
import { toCSV, toXLSX, toPDF } from '../../../../lib/accounting/export';

/**
 * Consolidated statements across organizations the user is assigned to in the CURRENT environment.
 * Journals are combined by simple aggregation. Inter-company balances (1500/2600) are shown,
 * NOT eliminated — elimination requires matching both sides and is left to review.
 */
function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

async function handler(req: Request) {
  try {
    const u = new URL(req.url); const mode = sessionMode(req);
    const username = String(req.headers.get('x-aksh-user') || ''); const isAdmin = req.headers.get('x-aksh-role') === 'ADMIN';
    const a = adminDb();
    // Organization assignment is required for every role (administrators included), as for Party Master visibility.
    void isAdmin;
    const allowed = (a.prepare(`SELECT c.id, c.name FROM companies c JOIN user_companies uc ON uc.company_id=c.id JOIN admin_users x ON x.id=uc.user_id WHERE x.username=? AND x.active=1 AND c.active=1 AND ${mode === 'TEST' ? 'uc.can_test=1' : 'uc.can_live=1'} ORDER BY c.name`).all(username)) as any[];
    const requested = (u.searchParams.get('company_ids') || '').split(',').map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);
    const selected = requested.length ? allowed.filter((c) => requested.includes(Number(c.id))) : allowed;
    if (requested.length && selected.length !== requested.length) return NextResponse.json({ error: 'One or more selected organizations are not assigned to you in this environment.' }, { status: 403 });
    const fy = financialYear(today());
    const from = u.searchParams.get('from') || fy.start, to = u.searchParams.get('to') || today(), asOf = u.searchParams.get('as_of') || to;
    const journals: Journal[] = selected.map((c) => buildJournal(db(mode, Number(c.id))));
    const combined: Journal = { accounts: new Map(), vouchers: [], exceptions: [], partyNames: new Map() };
    journals.forEach((j, i) => {
      for (const [k, v] of j.accounts) combined.accounts.set(k.startsWith('1100.') ? `1100.${selected[i].id}.${k.slice(5)}` : k, k.startsWith('1100.') ? { ...v, code: `1100.${selected[i].id}.${k.slice(5)}`, name: `${selected[i].name} — ${v.name}` } : v);
      for (const v of j.vouchers) combined.vouchers.push({ ...v, id: `${selected[i].id}:${v.id}`, lines: v.lines.map((l) => ({ ...l, account: l.account.startsWith('1100.') ? `1100.${selected[i].id}.${l.account.slice(5)}` : l.account, party: l.party ? `${selected[i].id}:${l.party}` : null })) });
      for (const e of j.exceptions) combined.exceptions.push({ ...e, message: `[${selected[i].name}] ${e.message}` });
    });
    combined.vouchers.sort((x, y) => x.date.localeCompare(y.date));
    const perOrg = selected.map((c, i) => { const bs = balanceSheet(journals[i], asOf); const pl = incomeStatement(journals[i], { from, to }); return { id: c.id, name: c.name, total_assets: bs.total_assets, total_liabilities: bs.total_liabilities, total_equity: bs.total_equity, net_profit: pl.net_profit, balanced: bs.balanced }; });
    const bs = balanceSheet(combined, asOf), pl = incomeStatement(combined, { from, to }), tb = trialBalance(combined, { from, to });
    const interco = tb.rows.filter((r) => r.code === '1500' || r.code === '2600');
    const table = { title: 'Report Group — Consolidated', subtitle: `${selected.map((c) => c.name).join(', ')} · ${mode} · ${from} to ${to}`, columns: [], rows: [], sections: [
      { title: 'By organization', columns: [{ key: 'name', label: 'Organization' }, { key: 'total_assets', label: 'Assets', type: 'money' as const }, { key: 'total_liabilities', label: 'Liabilities', type: 'money' as const }, { key: 'total_equity', label: 'Equity', type: 'money' as const }, { key: 'net_profit', label: 'Net profit (period)', type: 'money' as const }], rows: perOrg },
      { title: 'Consolidated income statement', columns: [{ key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', type: 'money' as const }], rows: [...pl.income, ...pl.expense.map((e) => ({ ...e, amount: -e.amount })), { name: 'Net profit / (loss)', amount: pl.net_profit }] },
      { title: 'Consolidated balance sheet', columns: [{ key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', type: 'money' as const }], rows: [...bs.assets, { name: 'Total assets', amount: bs.total_assets }, ...bs.liabilities, { name: 'Total liabilities', amount: bs.total_liabilities }, ...bs.equity, { name: 'Profit & loss to date', amount: bs.profit_and_loss_to_date }, { name: 'Total equity', amount: bs.total_equity }] },
    ], notes: ['Simple aggregation of each organization’s derived ledger in the current environment.', `Inter-company balances are NOT eliminated (receivable ${interco.find((r) => r.code === '1500') ? 'present' : 'none'}, payable ${interco.find((r) => r.code === '2600') ? 'present' : 'none'}). Review before presenting consolidated figures.`] };
    const format = u.searchParams.get('format');
    const meta = { organization: 'Report Group', generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' };
    if (format === 'csv') return new Response(toCSV(table), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="report-group.csv"' } });
    if (format === 'xlsx') return new Response(new Uint8Array(toXLSX(table)), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="report-group.xlsx"' } });
    if (format === 'pdf') return new Response(new Uint8Array(toPDF(table, meta)), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report-group.pdf"' } });
    return NextResponse.json({ meta: { mode, organizations: selected, available: allowed, from, to, as_of: asOf, amounts: 'paise' }, data: { per_org: perOrg, balance_sheet: bs, income_statement: pl, trial_balance: tb, exceptions: combined.exceptions }, table });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}

export const runtime = 'nodejs';
const selectedFiles = (req:Request,admin:any)=>{const u=new URL(req.url);const mode=req.headers.get('x-aksh-mode')==='TEST'?'TEST' as const:'LIVE' as const;const ids=(u.searchParams.get('company_ids')||'').split(',').map(Number).filter((n)=>Number.isSafeInteger(n)&&n>0);if(ids.length)return ids.map((id)=>({id,mode}));if(u.searchParams.get('init')==='1')return [];const username=String(req.headers.get('x-aksh-user')||'');const all=req.headers.get('x-aksh-role')==='ADMIN'?admin.prepare('SELECT id FROM companies WHERE active=1').all():admin.prepare(`SELECT c.id FROM companies c JOIN user_companies uc ON uc.company_id=c.id JOIN admin_users usr ON usr.id=uc.user_id WHERE usr.username=? AND usr.active=1 AND c.active=1 AND ${mode==='TEST'?'uc.can_test=1':'uc.can_live=1'}`).all(username);return (all as any[]).map((r:any)=>({id:Number(r.id),mode}))};
const __wrapped_GET = withPostgresSQLiteBridge(handler, { scope: 'company', extraFiles: selectedFiles });
export async function GET(req: Request) { return __wrapped_GET(req); }
