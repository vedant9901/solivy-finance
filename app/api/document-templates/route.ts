import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { conditionalJson, companyWatermark } from '../../../lib/data-version';
import { NextResponse } from 'next/server';
import { db, sessionMode } from '../../../lib/db';
import { TEMPLATES, isTemplate } from '../../../lib/documents/templates';
import { resolveDocumentPreference, sanitizeTheme, type DocType } from '../../../lib/documents/preferences';

/**
 * Bill template preferences.
 * GET  → templates, effective preference per document type, sample purchase for live preview.
 * POST {doc_type, template_id, theme?, scope:'user'|'company'} — company scope needs admin or Document Settings.
 */
const DOC_TYPES: DocType[] = ['commercial', 'third-party'];
function canCompany(req: Request) { if (req.headers.get('x-aksh-role') === 'ADMIN') return true; try { return JSON.parse(req.headers.get('x-aksh-menu') || '[]').includes('document-settings'); } catch { return false; } }

async function getHandler(req: Request) {
  const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1)); const user = String(req.headers.get('x-aksh-user') || '');
  const sample = d.prepare("SELECT id, sample_no FROM purchases WHERE status='POSTED' ORDER BY id DESC LIMIT 1").get() as any;
  const thirdParty = d.prepare('SELECT id, name FROM third_parties WHERE active=1 ORDER BY id LIMIT 1').get() as any;
  return NextResponse.json({ templates: TEMPLATES, preferences: Object.fromEntries(DOC_TYPES.map((t) => [t, resolveDocumentPreference(d, user, t)])), sample_purchase: sample || null, sample_third_party: thirdParty || null, can_set_company: canCompany(req) });
}
async function postHandler(req: Request) {
  try {
    const x = await req.json();
    if (!DOC_TYPES.includes(x.doc_type)) throw new Error('Unknown document type.');
    if (!isTemplate(x.template_id)) throw new Error('Unknown template.');
    const scopeKind = x.scope === 'company' ? 'company' : 'user';
    if (scopeKind === 'company' && !canCompany(req)) return NextResponse.json({ error: 'Only administrators or users with Document Settings access can set the organization default.' }, { status: 403 });
    const user = String(req.headers.get('x-aksh-user') || '');
    const scope = scopeKind === 'company' ? 'company' : `user:${user}`;
    const d = db(sessionMode(req), Number(req.headers.get('x-aksh-company-id') || 1));
    d.prepare('INSERT INTO document_preferences(scope, doc_type, template_id, theme, updated_by, updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(scope, doc_type) DO UPDATE SET template_id=excluded.template_id, theme=excluded.theme, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP')
      .run(scope, x.doc_type, x.template_id, JSON.stringify(sanitizeTheme(x.theme || {})), user);
    return NextResponse.json({ ok: true, preference: resolveDocumentPreference(d, user, x.doc_type) });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
}
export const runtime = 'nodejs';
const __wrapped_GET = withPostgresSQLiteBridge((req:Request)=>conditionalJson(req,['doctemplates-v1',companyWatermark(db(sessionMode(req),Number(req.headers.get('x-aksh-company-id')||1))),req.headers.get('x-aksh-company-id'),req.headers.get('x-aksh-mode'),req.headers.get('x-aksh-user')],()=>getHandler(req))); const __wrapped_POST = withPostgresSQLiteBridge(postHandler);
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
