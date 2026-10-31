/**
 * Declared database access class for every API route and method (v2.7.2).
 *
 *   NO_DB  the route must never reach PostgreSQL and never hydrate a snapshot.
 *   READ   the route may read data; it must never persist a snapshot. The only exceptions the
 *          bridge allows are a schema migration of a file it had to open, and a file it created,
 *          because refusing those would lose an upgrade. Anything else is recorded as a violation
 *          and NOT uploaded.
 *   WRITE  the route may persist, and only the chunks whose bytes actually changed.
 *
 * The registry is the single place these are declared, so the classes can be reviewed in one view
 * and enforced in one place. `scripts/check-api-access.cjs` fails the build when a route or method
 * is missing here, when a NO_DB route imports database code, or when a route declares a method it
 * does not export. The bridge reads this registry — not its call sites — so a route cannot quietly
 * grant itself write access.
 */
export type AccessClass = 'NO_DB' | 'READ' | 'WRITE';
export type MethodMap = Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', AccessClass>>;

const R: AccessClass = 'READ';
const W: AccessClass = 'WRITE';

export const API_ACCESS: Record<string, MethodMap> = {
  // ---- no database at all -------------------------------------------------
  '/api/logout': { POST: 'NO_DB' },

  // ---- reads --------------------------------------------------------------
  '/api/data': { GET: R },
  '/api/accounts': { GET: R, POST: W, PUT: W, DELETE: W },
  '/api/account-movements': { GET: R, POST: W },
  '/api/admin-backup-all': { GET: R },
  '/api/admin/data-health': { GET: R, POST: W },
  '/api/admin/transfer-metrics': { GET: R },
  '/api/backup': { GET: R },
  '/api/bank': { GET: R, POST: W },
  '/api/budgets': { GET: R, POST: W },
  '/api/companies': { GET: R, POST: W, PUT: W, PATCH: W },
  '/api/document-settings': { GET: R, POST: W },
  '/api/document-templates': { GET: R, POST: W },
  '/api/export/gst': { GET: R },
  '/api/export/ledger': { GET: R },
  '/api/export/payments': { GET: R },
  '/api/export/purchases': { GET: R },
  '/api/funding': { GET: R, POST: W, PUT: W },
  '/api/funding/pay': { POST: W },
  '/api/funding/transfer': { GET: R, POST: W },
  '/api/godowns': { GET: R, POST: W },
  '/api/group-mis': { GET: R },
  '/api/import-finance': { GET: R, POST: W },
  '/api/intercompany-targets': { GET: R },
  '/api/license/status': { GET: R },
  '/api/login-companies': { GET: R },
  '/api/party-aliases': { GET: R, POST: W, PUT: W, DELETE: W },
  '/api/payment-advice': { GET: R },
  '/api/profile': { GET: R, POST: W },
  '/api/purchase-bill': { GET: R },
  '/api/receivables': { GET: R, POST: W, PUT: W },
  '/api/reports': { GET: R, POST: W },
  '/api/reports/group': { GET: R },
  '/api/saudas': { GET: R, POST: W, PUT: W, PATCH: W },
  '/api/secondary-backup': { GET: R, POST: W, PUT: W },
  '/api/setup': { GET: R, POST: W },
  '/api/sync/verify': { POST: R },
  '/api/tally-export': { GET: R },
  '/api/tally-mapping': { GET: R, POST: W },
  '/api/tds-check': { POST: R },
  '/api/transfers': { GET: R, POST: W },
  '/api/transfers/destinations': { GET: R },
  '/api/users': { GET: R, POST: W, DELETE: W },

  // ---- writes -------------------------------------------------------------
  '/api/admin': { POST: W },
  '/api/bank-statement-import': { POST: W, PUT: W },
  '/api/forgot-password': { POST: W },
  '/api/interest-payments': { POST: W },
  '/api/login': { POST: W },               // session issue, login throttle, failure counters
  '/api/money-in': { POST: W },
  '/api/money-out': { POST: W },
  '/api/money-out/reverse': { POST: W },
  '/api/parties': { POST: W },
  '/api/parties-delete': { POST: W },
  '/api/payments': { POST: W, PUT: W },
  '/api/purchases': { POST: W, PUT: W },
  '/api/receipts': { POST: W },
  '/api/reset-password': { POST: W },
  '/api/reverse': { POST: W },
  '/api/sales': { POST: W, PUT: W },
  '/api/settings': { POST: W },
  '/api/switch-company': { POST: W },
  '/api/switch-environment': { POST: W },
  '/api/sync/exchange': { GET: W, POST: W },  // records device acknowledgements and last-seen
  '/api/sync/pair': { POST: W, DELETE: W },
  '/api/sync/clone': { GET: W, POST: W },      // hub side: staging, verification, activation
  '/api/sync/clone/run': { POST: W },          // device side: orchestrates a clone in either direction
  '/api/sync/rejects': { GET: W, POST: W },  // creates/updates the local quarantine table
  '/api/sync/resolve': { POST: W },
  '/api/sync/run': { POST: W },
  '/api/test-to-live': { POST: W },
  '/api/third-parties': { POST: W, PUT: W, DELETE: W },
};

export function routeOfUrl(url: string): string {
  try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return '/'; }
}

/** Declared class, or null when the route/method pair is not registered. */
export function accessFor(url: string, method: string): AccessClass | null {
  const entry = API_ACCESS[routeOfUrl(url)];
  if (!entry) return null;
  return entry[method.toUpperCase() as keyof MethodMap] ?? null;
}

/**
 * Class used at runtime. An unregistered route is treated as READ for GET/HEAD and WRITE
 * otherwise: a missing declaration must never silently widen access, and the check script keeps
 * the registry complete.
 */
export function effectiveAccess(url: string, method: string): { access: AccessClass; declared: boolean } {
  const declared = accessFor(url, method);
  if (declared) return { access: declared, declared: true };
  return { access: ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'READ' : 'WRITE', declared: false };
}
