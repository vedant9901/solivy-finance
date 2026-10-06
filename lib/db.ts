import { Pool, types as pgTypes, type PoolClient, type QueryResult } from 'pg';

export type Mode = 'LIVE' | 'TEST';

const ONLINE = Boolean(process.env.DATABASE_URL) && process.env.DEPLOYMENT_MODE !== 'offline' && process.env.NODE_ENV === 'production';

// Keep PostgreSQL numeric results compatible with SQLite's JavaScript numbers.
try {
  pgTypes.setTypeParser(20, (v) => Number(v));
  pgTypes.setTypeParser(1700, (v) => Number(v));
} catch {}

const COMPANY_DDL = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'DATA_ENTRY', password TEXT DEFAULT '', password_hash TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS company_settings (id INTEGER PRIMARY KEY CHECK(id=1), entity_name TEXT NOT NULL DEFAULT 'SOLIVY', tan TEXT DEFAULT '', deductor_type TEXT NOT NULL DEFAULT 'COMPANY', preceding_turnover REAL NOT NULL DEFAULT 0, tds_auto INTEGER NOT NULL DEFAULT 1, commercial_bill_settings TEXT NOT NULL DEFAULT '{}', payment_advice_settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS third_parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT DEFAULT '', contact TEXT DEFAULT '', gst TEXT DEFAULT '', pan TEXT DEFAULT '', email TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT DEFAULT '', contact TEXT DEFAULT '', email TEXT DEFAULT '', gst TEXT DEFAULT '', pan TEXT DEFAULT '', party_type TEXT NOT NULL DEFAULT 'GOODS_VENDOR', entity_type TEXT NOT NULL DEFAULT 'OTHER', resident_status TEXT NOT NULL DEFAULT 'RESIDENT', pan_status TEXT NOT NULL DEFAULT 'VALID', tds_enabled INTEGER NOT NULL DEFAULT 0, tds_section TEXT DEFAULT '', tds_rate REAL NOT NULL DEFAULT 0, tds_exempt INTEGER NOT NULL DEFAULT 0, opening_balance REAL NOT NULL DEFAULT 0, opening_balance_type TEXT NOT NULL DEFAULT 'PAYABLE', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bank_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE, bank_name TEXT NOT NULL, account_holder TEXT DEFAULT '', account_number TEXT DEFAULT '', ifsc TEXT DEFAULT '', branch TEXT DEFAULT '', is_primary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS company_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, bank_name TEXT NOT NULL, account_number TEXT DEFAULT '', ifsc TEXT DEFAULT '', branch TEXT DEFAULT '', account_type TEXT NOT NULL DEFAULT 'BANK', opening_balance REAL NOT NULL DEFAULT 0, opening_date TEXT NOT NULL DEFAULT CURRENT_DATE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS account_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES company_accounts(id), transaction_date TEXT NOT NULL, transaction_type TEXT NOT NULL, amount REAL NOT NULL, reference_type TEXT DEFAULT '', reference_id INTEGER, reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS account_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement_no TEXT UNIQUE NOT NULL, movement_type TEXT NOT NULL, movement_date TEXT NOT NULL, from_account_id INTEGER NOT NULL REFERENCES company_accounts(id), to_account_id INTEGER REFERENCES company_accounts(id), amount REAL NOT NULL, reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_no TEXT UNIQUE NOT NULL, party_id INTEGER NOT NULL REFERENCES parties(id), purchase_date TEXT NOT NULL, goods_description TEXT DEFAULT '', bags_qty REAL NOT NULL DEFAULT 0, invoice_no TEXT DEFAULT '', hsn TEXT DEFAULT '', gst_type TEXT DEFAULT 'NONE', gst_rate REAL NOT NULL DEFAULT 0, gst_taxable REAL NOT NULL DEFAULT 0, gst_amount REAL NOT NULL DEFAULT 0, gross_weight REAL NOT NULL, net_weight REAL NOT NULL, rate REAL NOT NULL, freight REAL NOT NULL DEFAULT 0, unload_charge REAL NOT NULL DEFAULT 0, moisture REAL NOT NULL DEFAULT 0, discount_pct REAL NOT NULL DEFAULT 0, driver_rokdi REAL NOT NULL DEFAULT 0, other_charges REAL NOT NULL DEFAULT 0, quality_deduct_per_mt REAL NOT NULL DEFAULT 0, gross_amount REAL NOT NULL, discount_amount REAL NOT NULL, quality_deduct_amount REAL NOT NULL, total_deduction REAL NOT NULL, net_payable REAL NOT NULL, status TEXT NOT NULL DEFAULT 'POSTED', notes TEXT DEFAULT '', payment_due_days INTEGER NOT NULL DEFAULT 0, payment_due_date TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_no TEXT UNIQUE NOT NULL, party_id INTEGER NOT NULL REFERENCES parties(id), payment_date TEXT NOT NULL, amount REAL NOT NULL, tds_rate REAL NOT NULL DEFAULT 0, tds_amount REAL NOT NULL DEFAULT 0, net_paid REAL NOT NULL DEFAULT 0, broker_name TEXT DEFAULT '', broker_email TEXT DEFAULT '', mode TEXT NOT NULL, company_account_id INTEGER REFERENCES company_accounts(id), bank_name TEXT DEFAULT '', utr TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', tds_base REAL NOT NULL DEFAULT 0, tds_rule TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payment_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE, purchase_id INTEGER NOT NULL REFERENCES purchases(id), amount REAL NOT NULL, UNIQUE(payment_id,purchase_id));
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id), entry_date TEXT NOT NULL, entry_type TEXT NOT NULL, reference_id INTEGER, reference_no TEXT, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, narration TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, details TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bank_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE, statement_date TEXT NOT NULL, statement_amount REAL NOT NULL, reference TEXT DEFAULT '', matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(payment_id));
CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT UNIQUE NOT NULL, invoice_date TEXT NOT NULL, customer_name TEXT NOT NULL, customer_gstin TEXT DEFAULT '', place_of_supply TEXT DEFAULT '', invoice_type TEXT NOT NULL DEFAULT 'B2B', hsn TEXT DEFAULT '', description TEXT DEFAULT '', taxable_value REAL NOT NULL, discount_pct REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0, receivable_base REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 0, cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0, igst REAL NOT NULL DEFAULT 0, total_value REAL NOT NULL, status TEXT NOT NULL DEFAULT 'POSTED', due_days INTEGER NOT NULL DEFAULT 0, due_date TEXT DEFAULT '', cost_amount REAL NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, received_date TEXT DEFAULT '', received_amount REAL NOT NULL DEFAULT 0, receipt_account_id INTEGER REFERENCES company_accounts(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS financing_receivables (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL UNIQUE REFERENCES purchases(id), party_id INTEGER NOT NULL REFERENCES parties(id), bill_no TEXT NOT NULL, bill_date TEXT NOT NULL, cost_amount REAL NOT NULL, discount_amount REAL NOT NULL DEFAULT 0, other_charges_profit REAL NOT NULL DEFAULT 0, receivable_amount REAL NOT NULL, due_days INTEGER NOT NULL DEFAULT 0, due_date TEXT DEFAULT '', received_amount REAL NOT NULL DEFAULT 0, received_date TEXT DEFAULT '', receipt_account_id INTEGER REFERENCES company_accounts(id), status TEXT NOT NULL DEFAULT 'OPEN', notes TEXT DEFAULT '', tds_rate REAL NOT NULL DEFAULT 0, tds_amount REAL NOT NULL DEFAULT 0, net_received REAL NOT NULL DEFAULT 0, tds_section TEXT DEFAULT '', tds_reference TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS money_in (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_no TEXT UNIQUE NOT NULL, receipt_date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES company_accounts(id), amount REAL NOT NULL, receipt_type TEXT NOT NULL, party_id INTEGER REFERENCES parties(id), reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS interest_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_no TEXT UNIQUE NOT NULL, payment_date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES company_accounts(id), amount REAL NOT NULL, payee TEXT DEFAULT '', party_id INTEGER REFERENCES parties(id), reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS funding_loans (id INTEGER PRIMARY KEY AUTOINCREMENT, loan_no TEXT UNIQUE NOT NULL, lender_party_id INTEGER REFERENCES parties(id), lender_name TEXT NOT NULL, loan_start_date TEXT NOT NULL, principal_amount REAL NOT NULL, interest_type TEXT NOT NULL DEFAULT 'PERCENT', interest_rate REAL NOT NULL DEFAULT 0, fixed_interest_amount REAL NOT NULL DEFAULT 0, frequency TEXT NOT NULL DEFAULT 'MONTHLY', first_payment_date TEXT DEFAULT '', bank_name TEXT DEFAULT '', account_number TEXT DEFAULT '', ifsc TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS funding_schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id INTEGER NOT NULL REFERENCES funding_loans(id) ON DELETE CASCADE, due_date TEXT NOT NULL, interest_amount REAL NOT NULL, principal_due REAL NOT NULL DEFAULT 0, paid_amount REAL NOT NULL DEFAULT 0, paid_date TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'DUE');
CREATE TABLE IF NOT EXISTS import_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, row_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'IMPORTED');
`;

const ADMIN_DDL = `
CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,code TEXT UNIQUE NOT NULL,address TEXT DEFAULT '',city TEXT DEFAULT '',state TEXT DEFAULT '',email TEXT DEFAULT '',gstin TEXT DEFAULT '',pan TEXT DEFAULT '',financial_year TEXT DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'DATA_ENTRY',password TEXT DEFAULT '',password_hash TEXT DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS user_companies(user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,can_live INTEGER NOT NULL DEFAULT 1,can_test INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,company_id));
`;

const ID_TABLES = new Set(['users','third_parties','parties','bank_accounts','company_accounts','account_transactions','account_movements','purchases','payments','payment_allocations','ledger','audit_logs','bank_matches','sales','financing_receivables','money_in','interest_payments','funding_loans','funding_schedule','import_batches','companies','admin_users']);

function pgSchemaName(kind: 'admin' | 'company', companyId?: number, mode?: Mode) {
  if (kind === 'admin') return 'solivy_admin';
  return `solivy_c${Number(companyId || 1)}_${String(mode || 'LIVE').toLowerCase()}`;
}

function pgDdl(ddl: string) {
  return ddl
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/ REAL /g, ' DOUBLE PRECISION ')
    .replace(/ REAL NOT NULL/g, ' DOUBLE PRECISION NOT NULL')
    .replace(/ REAL DEFAULT/g, ' DOUBLE PRECISION DEFAULT')
    .replace(/ REAL,/g, ' DOUBLE PRECISION,');
}

const pgPools = new Map<string, Pool>();
const pgReady = new Map<string, Promise<void>>();

function getDatabaseConnectionString() {
  const raw = String(process.env.DATABASE_URL || '').trim();
  if (!raw) return raw;
  // Neon rejects search_path when it is supplied as a startup parameter.
  // Keep any other Neon options (for example project routing) but remove only search_path.
  try {
    const u = new URL(raw);
    const options = u.searchParams.get('options');
    if (options && /search_path/i.test(options)) {
      const cleaned = options
        .replace(/(?:^|[\s,;])(?:-c\s+)?search_path\s*=\s*[^\s,;]+/ig, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (cleaned) u.searchParams.set('options', cleaned);
      else u.searchParams.delete('options');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function getPgPool(schema: string) {
  let pool = pgPools.get(schema);
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseConnectionString(),
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
    pgPools.set(schema, pool);
  }
  return pool;
}

async function ensurePgSchema(schema: string, kind: 'admin' | 'company') {
  const existing = pgReady.get(schema);
  if (existing) return existing;
  const promise = (async () => {
    // Schema names are generated internally and never contain user-controlled SQL.
    const bootstrap = new Pool({ connectionString: getDatabaseConnectionString(), max: 1, connectionTimeoutMillis: 15000 });
    const client = await bootstrap.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      // Run the DDL and seed in one transaction so a failed first request cannot leave
      // a half-initialized online database behind.
      await client.query('BEGIN');
      // Serialize admin bootstrap across Vercel/Neon serverless instances.
      // Without this, two cold-starts can race while creating/seeding admin data.
      if (kind === 'admin') {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('solivy_admin_bootstrap'))`);
      }
      await client.query(pgDdl(kind === 'admin' ? ADMIN_DDL : COMPANY_DDL));
      if (kind === 'company') {
        await client.query(`INSERT INTO company_settings(id,entity_name) VALUES(1,'SOLIVY') ON CONFLICT (id) DO NOTHING`);
      } else {
        await client.query(`INSERT INTO companies(name,code) VALUES('SOLIVY','SOLIVY') ON CONFLICT DO NOTHING`);
        await client.query(`INSERT INTO admin_users(username,name,role,password) VALUES('admin','Administrator','ADMIN','admin123') ON CONFLICT DO NOTHING`);
        await client.query(`INSERT INTO admin_users(username,name,role,password) VALUES('tester','Test User','TESTER','test123') ON CONFLICT DO NOTHING`);
        const company = await client.query(`SELECT id FROM companies WHERE code='SOLIVY' LIMIT 1`);
        const admin = await client.query(`SELECT id FROM admin_users WHERE username='admin' LIMIT 1`);
        const tester = await client.query(`SELECT id FROM admin_users WHERE username='tester' LIMIT 1`);
        if (!company.rows[0]) throw new Error('Unable to initialize default SOLIVY company');
        if (!admin.rows[0]) throw new Error('Unable to initialize default admin user');
        await client.query(`INSERT INTO user_companies(user_id,company_id,can_live,can_test) VALUES($1,$2,1,1) ON CONFLICT (user_id,company_id) DO UPDATE SET can_live=EXCLUDED.can_live, can_test=EXCLUDED.can_test`, [admin.rows[0].id, company.rows[0].id]);
        if (tester.rows[0]) await client.query(`INSERT INTO user_companies(user_id,company_id,can_live,can_test) VALUES($1,$2,0,1) ON CONFLICT (user_id,company_id) DO UPDATE SET can_live=EXCLUDED.can_live, can_test=EXCLUDED.can_test`, [tester.rows[0].id, company.rows[0].id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
      await bootstrap.end();
    }
  })();
  pgReady.set(schema, promise);
  try { await promise; } catch (e) { pgReady.delete(schema); throw e; }
}

function convertSql(sql: string) {
  let q = sql.trim();
  if (/^PRAGMA\s+table_info\(/i.test(q)) return q;
  if (/^DELETE\s+FROM\s+sqlite_sequence/i.test(q)) return '';
  q = q.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  q = q.replace(/GROUP_CONCAT\(([^)]+)\)/gi, `STRING_AGG(CAST($1 AS TEXT), ',')`);
  q = q.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+user_companies/i, 'INSERT INTO user_companies');
  if (/^INSERT\s+INTO\s+user_companies/i.test(q) && /ON CONFLICT/i.test(q) === false) {
    q += ' ON CONFLICT (user_id,company_id) DO UPDATE SET can_live=EXCLUDED.can_live, can_test=EXCLUDED.can_test';
  } else if (/^INSERT\s+INTO/i.test(q) && /ON CONFLICT/i.test(q) === false && /payment_allocations/i.test(q)) {
    q += ' ON CONFLICT DO NOTHING';
  }
  // SQLite date('date','+'||days||' days') -> PostgreSQL date arithmetic.
  // Consume the complete date() expression in one pass so we never leave an
  // unmatched parenthesis before SQL clauses such as END.
  q = q.replace(
    /date\(\s*([^,]+?)\s*,\s*'\+'\s*\|\|\s*([^|,)]+?)\s*\|\|\s*' days'\s*\)/gi,
    `CAST((CAST($1 AS date) + (CAST($2 AS numeric) * INTERVAL '1 day')) AS text)`
  );
  return q;
}

function bindParams(sql: string, args: any[]) {
  let i = 0;
  const text = sql.replace(/\?/g, () => `$${++i}`);
  return { text, values: args };
}

interface StatementLike {
  get(...args: any[]): Promise<any>;
  all(...args: any[]): Promise<any[]>;
  run(...args: any[]): Promise<{ lastInsertRowid: number; changes: number }>;
}

class SqliteAsyncDb {
  constructor(private readonly d: any) {}
  prepare(sql: string): StatementLike {
    const stmt = this.d.prepare(sql);
    return {
      get: async (...args) => stmt.get(...args),
      all: async (...args) => stmt.all(...args) as any[],
      run: async (...args) => { const r = stmt.run(...args); return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes }; },
    };
  }
  async exec(sql: string) { if (sql) this.d.exec(sql); }
  transaction(fn: () => Promise<any> | any) {
    return async () => {
      this.d.exec('BEGIN');
      try { const result = await fn(); this.d.exec('COMMIT'); return result; }
      catch (e) { try { this.d.exec('ROLLBACK'); } catch {} throw e; }
    };
  }
  serialize() { return this.d.serialize(); }
  async close() {}
}

class PgAsyncDb {
  private txClient: PoolClient | null = null;
  constructor(private readonly pool: Pool, private readonly schema: string) {}
  private async query(text: string, values: any[] = []): Promise<QueryResult<any>> {
    if (this.txClient) return this.txClient.query(text, values);
    const client = await this.pool.connect();
    try {
      // Set schema per connection instead of using PostgreSQL startup options.
      // Neon rejects search_path as a startup parameter on pooled connections.
      await client.query(`SET search_path TO ${this.schema}`);
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }
  private async pragmaInfo(table: string) {
    const r = await this.query(`SELECT column_name name, ordinal_position cid, data_type type, is_nullable notnull, column_default dflt_value FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [this.schema, table]);
    return r.rows;
  }
  prepare(rawSql: string): StatementLike {
    const sql = convertSql(rawSql);
    const isPragma = /^PRAGMA\s+table_info\(([^)]+)\)/i.exec(sql);
    const tableName = isPragma ? isPragma[1].trim() : '';
    return {
      get: async (...args) => {
        if (isPragma) return (await this.pragmaInfo(tableName))[0];
        if (!sql) return undefined;
        const q = bindParams(sql, args);
        const r = await this.query(q.text, q.values);
        return r.rows[0];
      },
      all: async (...args) => {
        if (isPragma) return this.pragmaInfo(tableName);
        if (!sql) return [];
        const q = bindParams(sql, args);
        const r = await this.query(q.text, q.values);
        return r.rows;
      },
      run: async (...args) => {
        if (!sql) return { lastInsertRowid: 0, changes: 0 };
        let text = sql;
        const insert = /^INSERT\s+INTO\s+([a-zA-Z_][\w]*)/i.exec(text);
        const target = insert?.[1]?.toLowerCase();
        const shouldReturnId = !!target && ID_TABLES.has(target) && !/\bRETURNING\b/i.test(text);
        if (shouldReturnId) text += ' RETURNING id';
        const q = bindParams(text, args);
        const r = await this.query(q.text, q.values);
        return { lastInsertRowid: Number(r.rows[0]?.id || 0), changes: r.rowCount || 0 };
      },
    };
  }
  async exec(sql: string) {
    if (!sql) return;
    const normalized = sql.replace(/PRAGMA[^;]+;?/gi, '').replace(/DELETE\s+FROM\s+sqlite_sequence[^;]+;?/gi, '');
    if (normalized.trim()) await this.query(normalized);
  }
  transaction(fn: () => Promise<any> | any) {
    return async () => {
      const client = await this.pool.connect();
      this.txClient = client;
      try {
        await client.query('BEGIN');
        await client.query(`SET search_path TO ${this.schema}`);
        const result = await fn();
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      } finally {
        this.txClient = null;
        client.release();
      }
    };
  }
  async serialize() {
    const tables = [...ID_TABLES].filter((x) => x !== 'users');
    const out: Record<string, any[]> = {};
    for (const table of tables) {
      try { out[table] = await this.prepare(`SELECT * FROM ${table}`).all(); } catch { out[table] = []; }
    }
    return Buffer.from(JSON.stringify({ schema: this.schema, exportedAt: new Date().toISOString(), tables: out }), 'utf8');
  }
  async close() {}
}

async function onlineDb(mode: Mode, companyId: number) {
  const schema = pgSchemaName('company', companyId, mode);
  await ensurePgSchema(schema, 'company');
  return new PgAsyncDb(getPgPool(schema), schema);
}

export async function db(mode: Mode = 'LIVE', companyId = 1): Promise<SqliteAsyncDb | PgAsyncDb> {
  if (ONLINE) return onlineDb(mode, companyId);
  const mod = await import('./db-sqlite');
  return new SqliteAsyncDb(mod.db(mode, companyId));
}

export async function adminDb(): Promise<SqliteAsyncDb | PgAsyncDb> {
  if (ONLINE) {
    const schema = pgSchemaName('admin');
    await ensurePgSchema(schema, 'admin');
    return new PgAsyncDb(getPgPool(schema), schema);
  }
  const mod = await import('./db-sqlite');
  return new SqliteAsyncDb(mod.adminDb());
}

export async function resetMode(mode: Mode, companyId = 1) {
  const d = await db(mode, companyId);
  const tables = ['bank_matches','payment_allocations','account_movements','funding_schedule','payments','interest_payments','money_in','ledger','financing_receivables','purchases','sales','account_transactions','company_accounts','bank_accounts','funding_loans','parties','third_parties','import_batches','audit_logs'];
  await d.transaction(async () => { for (const t of tables) await d.prepare(`DELETE FROM ${t}`).run(); })();
}
export async function resetTest(companyId = 1) { return resetMode('TEST', companyId); }
export async function clearTransactionData(mode: Mode, companyId = 1) {
  const d = await db(mode, companyId);
  const tables = ['bank_matches','payment_allocations','account_movements','funding_schedule','payments','interest_payments','money_in','ledger','financing_receivables','purchases','sales','account_transactions'];
  await d.transaction(async () => { for (const t of tables) await d.prepare(`DELETE FROM ${t}`).run(); })();
}
export async function backup(mode: Mode, companyId = 1) { const d = await db(mode, companyId); return d.serialize(); }
export async function databasePath(mode: Mode, companyId = 1) {
  if (ONLINE) return `postgres://${pgSchemaName('company', companyId, mode)}`;
  const mod = await import('./db-sqlite');
  return mod.databasePath(mode, companyId);
}
