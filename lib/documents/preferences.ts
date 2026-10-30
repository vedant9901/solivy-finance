import { isTemplate, type Theme, type TemplateId } from './templates';
/** Document template preference: user-level overrides company-level; default 'classic'. */
export type DocType = 'commercial' | 'third-party' | 'payment-advice';
export function resolveDocumentPreference(d: any, username: string, docType: DocType): { template_id: TemplateId; theme: Theme; scope: string } {
  for (const scope of [`user:${username}`, 'company']) {
    try {
      const r = d.prepare('SELECT template_id, theme FROM document_preferences WHERE scope=? AND doc_type=?').get(scope, docType) as any;
      if (r && isTemplate(r.template_id)) { let theme: Theme = {}; try { theme = sanitizeTheme(JSON.parse(r.theme || '{}')); } catch {} return { template_id: r.template_id, theme, scope }; }
    } catch { /* table missing on a not-yet-migrated database */ }
  }
  return { template_id: 'classic', theme: {}, scope: 'default' };
}
export function sanitizeTheme(t: any): Theme {
  const out: Theme = {};
  if (typeof t?.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.accent)) out.accent = t.accent;
  if (['helvetica', 'times', 'courier'].includes(t?.font)) out.font = t.font;
  if (['normal', 'compact'].includes(t?.density)) out.density = t.density;
  return out;
}
