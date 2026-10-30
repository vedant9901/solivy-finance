import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { NextResponse } from 'next/server';
import { db, adminDb, sessionMode } from '../../../lib/db';
import { catalog, reportById, makeCtx, MANAGEMENT_PACKAGE, REPORTS, type Params } from '../../../lib/accounting/registry';
import { toCSV, toXLSX, toPDF, packagePDF } from '../../../lib/accounting/export';
import { financialYear } from '../../../lib/money';
import { companyWatermark, adminWatermark, etagFor, notModified, NOT_MODIFIED_HEADERS } from '../../../lib/data-version';

/**
 * GET /api/reports                       → catalog (visible to this user) + favourites
 * GET /api/reports?id=<report>&...params → report JSON { meta, data, table }
 *     &format=csv|xlsx|pdf               → download
 * POST /api/reports {action:'favorite', report_id, on} → star / unstar
 * Read-only for financial data. Amounts in JSON are paise (integer); exports are rupees.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function access(req: Request) {
  const isAdmin = req.headers.get('x-aksh-role') === 'ADMIN';
  let menu: string[] = []; try { menu = JSON.parse(req.headers.get('x-aksh-menu') || '[]'); } catch {}
  return (perms: string[]) => isAdmin || perms.some((p) => menu.includes(p));
}
function params(u: URL): Params | string {
  const p: any = {};
  for (const k of ['from', 'to', 'as_of']) { const v = u.searchParams.get(k); if (v) { if (!DATE.test(v)) return `Invalid ${k} date (use YYYY-MM-DD).`; p[k] = v; } }
  if (p.from && p.to && p.from > p.to) return 'From date must be on or before To date.';
  for (const k of ['account', 'party', 'user', 'entity']) { const v = u.searchParams.get(k); if (v) p[k] = v.slice(0, 120); }
  const fy = u.searchParams.get('fy'); if (fy) { if (!/^\d{4}-\d{2}$/.test(fy)) return 'Invalid fiscal year (use 2026-27).'; p.fy = fy; }
  for (const k of ['limit', 'offset', 'weeks']) { const v = Number(u.searchParams.get(k)); if (Number.isFinite(v) && v >= 0) p[k] = Math.floor(v); }
  return p;
}

async function getHandler(req: Request) {
  let __etag = '';
  try {
    const u = new URL(req.url); const can = access(req);
    const mode = sessionMode(req); const companyId = Number(req.headers.get('x-aksh-company-id') || 1);
    const d = db(mode, companyId); const user = String(req.headers.get('x-aksh-user') || '');
    const id = u.searchParams.get('id');
    // Conditional response (v2.7.1): the catalog and every JSON report body are reproducible from
    // the data watermark, the parameters and the caller's permissions, so an unchanged request is
    // answered with 304 and no body instead of recomputing and resending the report.
    const format = u.searchParams.get('format') || 'json';
    const wm = companyWatermark(d);
    if (format === 'json') {
      const etag = etagFor(['reports-v1', wm, adminWatermark(adminDb()), mode, companyId, user, req.headers.get('x-aksh-role') === 'ADMIN' ? 'admin' : String(req.headers.get('x-aksh-menu') || ''), u.search, today()]);
      if (notModified(req, etag)) return new NextResponse(null, { status: 304, headers: NOT_MODIFIED_HEADERS(etag) });
      __etag = etag;
    }
    if (!id) {
      const favorites = (d.prepare('SELECT report_id FROM report_favorites WHERE username=?').all(user) as any[]).map((r) => r.report_id);
      return NextResponse.json({ reports: catalog().filter((r) => can(r.permission)), favorites }, { headers: __etag ? NOT_MODIFIED_HEADERS(__etag) : undefined });
    }
    const def = reportById(id);
    if (!def) return NextResponse.json({ error: 'Unknown report.' }, { status: 404 });
    if (!can(def.permission)) return NextResponse.json({ error: 'This report is not included in your access.' }, { status: 403 });
    const p = params(u); if (typeof p === 'string') return NextResponse.json({ error: p }, { status: 400 });
    const org = adminDb().prepare('SELECT name FROM companies WHERE id=?').get(companyId) as any;
    const meta = { organization: `${org?.name || 'Organization'}${mode === 'TEST' ? ' (TEST)' : ''}`, generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' };
    const ctx = makeCtx(d, p, today());
    const file = `${id}-${(p as any).as_of || (p as any).to || today()}`;
    if (id === 'management-package') {
      const fy = financialYear(today());
      const pp = { from: (p as any).from || fy.start, to: (p as any).to || today() };
      const pctx = makeCtx(d, { ...p, ...pp, as_of: pp.to }, today());
      const tables = MANAGEMENT_PACKAGE.map((rid) => REPORTS.find((r) => r.id === rid)!).filter((r) => can(r.permission)).map((r) => r.run(pctx).table);
      const pdf = packagePDF('Management Reports', `${pp.from} to ${pp.to}`, tables, meta);
      return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="management-reports-${pp.to}.pdf"`, 'cache-control': 'no-store' } });
    }
    const out = def.run(ctx);
    if (format === 'csv') return new Response(toCSV(out.table), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file}.csv"`, 'cache-control': 'no-store' } });
    if (format === 'xlsx') return new Response(new Uint8Array(toXLSX(out.table)), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${file}.xlsx"`, 'cache-control': 'no-store' } });
    if (format === 'pdf') return new Response(new Uint8Array(toPDF(out.table, meta)), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${file}.pdf"`, 'cache-control': 'no-store' } });
    const { run, ...m } = def; void run;
    return NextResponse.json({ meta: { ...m, organization: meta.organization, params: p, amounts: 'paise' }, data: out.data, table: out.table }, { headers: __etag ? NOT_MODIFIED_HEADERS(__etag) : undefined });
  } catch (e: any) { return NextResponse.json({ error: e.message || 'Report failed.' }, { status: 500 }); }
}

async function postHandler(req: Request) {
  try {
    const x = await req.json();
    if (x.action !== 'favorite' || !reportById(String(x.report_id)) && x.report_id !== 'report-groups') return NextResponse.json({ error: 'Unknown action or report.' }, { status: 400 });
    const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1));
    const user = String(req.headers.get('x-aksh-user') || '');
    if (x.on) d.prepare('INSERT OR IGNORE INTO report_favorites(username, report_id) VALUES(?,?)').run(user, String(x.report_id));
    else d.prepare('DELETE FROM report_favorites WHERE username=? AND report_id=?').run(user, String(x.report_id));
    return NextResponse.json({ ok: true, favorites: (d.prepare('SELECT report_id FROM report_favorites WHERE username=?').all(user) as any[]).map((r) => r.report_id) });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
}

export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge(getHandler);
const __wrapped_POST = withPostgresSQLiteBridge(postHandler, { audit: false });
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
