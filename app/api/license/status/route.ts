import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminDb } from '../../../../lib/db';
import { COOKIE, verifySession } from '../../../../lib/session';

const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAInUktjI0jjuAmYTDfkOjKCiVopMVI3Gaa4cmxnwV1PQ=';
const DAY_MS = 24 * 60 * 60 * 1000;
const MODULES = [
  { id: 'core', name: 'Core access', description: 'Application access and core APIs' },
  { id: 'dashboard', name: 'Dashboard', description: 'KPIs and finance overview' },
  { id: 'accounts', name: 'Bank / Cash Accounts', description: 'Accounts and balances' },
  { id: 'account-movements', name: 'Withdrawals / Transfers', description: 'Account movements' },
  { id: 'parties', name: 'Parties', description: 'Vendors, customers and brokers' },
  { id: 'purchase', name: 'Purchase / Sample', description: 'Purchases and payable calculations' },
  { id: 'payments', name: 'Payments', description: 'Vendor payments and TDS' },
  { id: 'money-in', name: 'Money In', description: 'Receipts and cash inflows' },
  { id: 'interest', name: 'Interest Paid', description: 'Interest payment records' },
  { id: 'funding', name: 'Funding / Loans', description: 'Loans and interest schedules' },
  { id: 'import', name: 'CSV Import', description: 'Validated finance imports' },
  { id: 'ledger', name: 'Vendor Ledger', description: 'Vendor balances and history' },
  { id: 'receivables', name: 'Receivables', description: 'Customer receivables and collections' },
  { id: 'reports', name: 'Reports', description: 'Finance summaries and exports' },
  { id: 'bank', name: 'Bank Matching', description: 'Bank statement reconciliation' },
  { id: 'backup', name: 'Backup / Restore', description: 'Company data backups' },
  { id: 'gst', name: 'GST Filing', description: 'GST data and exports' },
  { id: 'commercial-bills', name: 'Commercial Bills', description: 'Commercial bill workflows' },
  { id: 'document-settings', name: 'Document Settings', description: 'Document layout and business details' },
  { id: 'settings', name: 'Company / TDS Settings', description: 'Company and tax settings' },
];

type LicenseInfo = {
  status: string; reason?: string; licenseId?: string; customer?: string; edition?: string; perpetual?: boolean;
  issuedAt?: string; expiresAt?: string | null; daysRemaining?: number; daysExpired?: number;
  modules: Array<{ id: string; name: string; description: string; included: boolean }>;
};

function readCookie(req: Request, name: string) {
  const cookies = req.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function parseToken(token: string, companyId: number): LicenseInfo {
  const denied = (status: string, reason: string): LicenseInfo => ({ status, reason, modules: MODULES.map(m => ({ ...m, included: false })) });
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 2) return denied('invalid', 'License token format is invalid.');
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const signature = Buffer.from(parts[1], 'base64url');
    const publicKey = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(parts[0]), publicKey, signature)) return denied('invalid', 'License signature is invalid.');
    if (payload.product !== 'SOLIVY_FINANCE' || !payload.licenseId || !payload.customer) return denied('invalid', 'License is not for SOLIVY Finance.');
    const issued = Date.parse(payload.issuedAt);
    const perpetual = payload.perpetual === true && payload.expiresAt === null;
    const expires = perpetual ? Number.POSITIVE_INFINITY : Date.parse(payload.expiresAt);
    if (!Number.isFinite(issued) || issued > Date.now() + 5 * 60 * 1000 || (!perpetual && !Number.isFinite(expires))) return denied('invalid', 'License dates are invalid.');
    const ids = Array.isArray(payload.companyIds) ? payload.companyIds : [];
    if (!(ids.includes('*') || ids.map(Number).includes(Number(companyId)))) return denied('not_assigned', 'License is not assigned to this organization.');
    const features = Array.isArray(payload.features) ? payload.features.map((x: unknown) => String(x)) : [];
    const all = features.includes('*');
    const modules = MODULES.map(m => ({ ...m, included: all || features.includes(m.id) }));
    if (!perpetual && expires <= Date.now()) return {
      status: 'expired', reason: 'License expired. The administrator can still sign in to review this page and arrange renewal.',
      licenseId: String(payload.licenseId), customer: String(payload.customer), edition: String(payload.edition || 'standard'),
      issuedAt: payload.issuedAt, expiresAt: payload.expiresAt, perpetual: false, daysRemaining: 0,
      daysExpired: Math.ceil((Date.now() - expires) / DAY_MS), modules,
    };
    return {
      status: 'valid', licenseId: String(payload.licenseId), customer: String(payload.customer), edition: String(payload.edition || 'standard'), perpetual,
      issuedAt: payload.issuedAt, expiresAt: perpetual ? null : payload.expiresAt, daysRemaining: perpetual ? undefined : Math.max(0, Math.ceil((expires - Date.now()) / DAY_MS)), modules,
    };
  } catch {
    return denied('invalid', 'License could not be validated.');
  }
}

export async function GET(req: Request) {
  try {
    const token = readCookie(req, COOKIE);
    const session = verifySession(token);
    if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    if (session.r !== 'ADMIN') return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 });

    const enforcement = (process.env.SOLIVY_LICENSE_ENFORCEMENT || 'off').toLowerCase();
    let map: Record<string, string> = {};
    const mapText = process.env.SOLIVY_LICENSES_JSON?.trim();
    if (mapText) {
      try { const parsed = JSON.parse(mapText); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); map = parsed; }
      catch { return NextResponse.json({ error: 'SOLIVY_LICENSES_JSON is not valid JSON.', enforcement, organizations: [] }, { status: 500 }); }
    }
    const fallback = process.env.SOLIVY_LICENSE_TOKEN?.trim() || '';
    const companies = adminDb().prepare('SELECT id,name,code,active FROM companies ORDER BY active DESC,name').all() as Array<{id:number;name:string;code:string;active:number}>;
    const organizations = companies.map(company => {
      const tokenForCompany = String(map[String(company.id)] || map['*'] || fallback || '');
      let license: LicenseInfo;
      if (!tokenForCompany) {
        license = { status: 'missing', reason: 'No license token is configured for this organization.', modules: MODULES.map(m => ({ ...m, included: false })) };
      } else {
        license = parseToken(tokenForCompany, Number(company.id));
      }
      return { companyId: Number(company.id), organization: company.name, code: company.code, active: Boolean(company.active), ...license };
    });
    return NextResponse.json({ product: 'SOLIVY_FINANCE', enforcement, organizations, moduleCatalog: MODULES });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || 'Unable to read license status.') }, { status: 500 });
  }
}
