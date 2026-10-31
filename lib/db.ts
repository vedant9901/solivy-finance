import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';

export type Mode = 'LIVE' | 'TEST';

/** Read the environment only from the authenticated session header injected by middleware. Never trust a body/query mode for ordinary finance operations. */
export function sessionMode(req: Request): Mode {
  const value = req.headers.get('x-aksh-mode');
  if (value !== 'LIVE' && value !== 'TEST') throw new Error('A valid authenticated environment is required. Sign in again.');
  return value;
}

// Vercel only permits temporary local working files under /tmp. The online
// bridge hydrates these SQLite working copies from PostgreSQL before a route
// runs and persists them back before returning the response.
const isVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV) || Boolean(process.env.VERCEL_REGION) || process.cwd().replace(/\\/g, '/').startsWith('/var/task');
const defaultRoot = isVercel
  ? path.join('/tmp', 'solivy-finance')
  : process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'), 'SOLIVY-FINANCE')
    : path.join(process.env.HOME || process.cwd(), '.solivy-finance');
// Financial data lives outside the application folder by default on local installs.
// On Vercel, /tmp is only a working copy; PostgreSQL is the durable source of truth.
const dataDir = path.resolve(process.env.FINANCE_DATA_DIR || path.join(defaultRoot, 'data'));
if (!isVercel || process.env.SOLIVY_SQLITE_BRIDGE === '1') fs.mkdirSync(dataDir, { recursive: true });
const dbCache = new Map<string, Database.Database>();

function ensureSchema(d: Database.Database) {
  d.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'DATA_ENTRY', password TEXT DEFAULT '', password_hash TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS company_settings (id INTEGER PRIMARY KEY CHECK(id=1), entity_name TEXT NOT NULL DEFAULT 'SOLIVY', tan TEXT DEFAULT '', deductor_type TEXT NOT NULL DEFAULT 'COMPANY', preceding_turnover REAL NOT NULL DEFAULT 0, tds_auto INTEGER NOT NULL DEFAULT 1, purchase_bill_start_after INTEGER NOT NULL DEFAULT 0, discount_after_quality INTEGER NOT NULL DEFAULT 1, commercial_bill_settings TEXT NOT NULL DEFAULT '{}', third_party_bill_settings TEXT NOT NULL DEFAULT '{}', payment_advice_settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS third_parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT DEFAULT '', contact TEXT DEFAULT '', gst TEXT DEFAULT '', pan TEXT DEFAULT '', email TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS godowns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT DEFAULT '', location TEXT DEFAULT '', capacity_qty REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS inventory_lots (id INTEGER PRIMARY KEY AUTOINCREMENT, godown_id INTEGER REFERENCES godowns(id), purchase_id INTEGER REFERENCES purchases(id), batch_no TEXT DEFAULT '', commodity TEXT NOT NULL DEFAULT '', qty_in REAL NOT NULL DEFAULT 0, qty_out REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'KG', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sauda_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, sauda_id INTEGER NOT NULL REFERENCES saudas(id) ON DELETE CASCADE, source_type TEXT NOT NULL, source_id INTEGER NOT NULL, godown_id INTEGER REFERENCES godowns(id), quantity REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'KG', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS saudas (id INTEGER PRIMARY KEY AUTOINCREMENT, sauda_no TEXT UNIQUE NOT NULL, sauda_date TEXT NOT NULL, commodity TEXT NOT NULL, purchase_party_id INTEGER NOT NULL REFERENCES parties(id), selling_party_id INTEGER NOT NULL REFERENCES parties(id), third_party_id INTEGER REFERENCES third_parties(id), quantity REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'MT', purchase_rate REAL NOT NULL DEFAULT 0, sale_rate REAL NOT NULL DEFAULT 0, truck_number TEXT DEFAULT '', from_location TEXT DEFAULT '', to_location TEXT DEFAULT '', delivery_date TEXT DEFAULT '', expenses REAL NOT NULL DEFAULT 0, notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'BOOKED', created_by TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT DEFAULT '', contact TEXT DEFAULT '', email TEXT DEFAULT '', gst TEXT DEFAULT '', pan TEXT DEFAULT '', party_type TEXT NOT NULL DEFAULT 'GOODS_VENDOR', entity_type TEXT NOT NULL DEFAULT 'OTHER', resident_status TEXT NOT NULL DEFAULT 'RESIDENT', pan_status TEXT NOT NULL DEFAULT 'VALID', tds_enabled INTEGER NOT NULL DEFAULT 0, tds_section TEXT DEFAULT '', tds_rate REAL NOT NULL DEFAULT 0, tds_exempt INTEGER NOT NULL DEFAULT 0, opening_balance REAL NOT NULL DEFAULT 0, opening_balance_type TEXT NOT NULL DEFAULT 'PAYABLE', source_company_id INTEGER DEFAULT NULL, source_party_id INTEGER DEFAULT NULL, source_company_name TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS party_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE, alias TEXT NOT NULL COLLATE NOCASE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(alias));
CREATE TABLE IF NOT EXISTS bank_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE, bank_name TEXT NOT NULL, account_holder TEXT DEFAULT '', account_number TEXT DEFAULT '', ifsc TEXT DEFAULT '', branch TEXT DEFAULT '', is_primary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS company_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, bank_name TEXT NOT NULL, account_number TEXT DEFAULT '', ifsc TEXT DEFAULT '', branch TEXT DEFAULT '', account_type TEXT NOT NULL DEFAULT 'BANK', opening_balance REAL NOT NULL DEFAULT 0, opening_date TEXT NOT NULL DEFAULT CURRENT_DATE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS account_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES company_accounts(id), transaction_date TEXT NOT NULL, transaction_type TEXT NOT NULL, amount REAL NOT NULL, reference_type TEXT DEFAULT '', reference_id INTEGER, reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tds_credit_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, receivable_id INTEGER NOT NULL, transaction_date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount >= 0), section TEXT DEFAULT '', certificate_reference TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVERSED')), source_transaction_id INTEGER, narration TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS account_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement_no TEXT UNIQUE NOT NULL, movement_type TEXT NOT NULL, movement_date TEXT NOT NULL, from_account_id INTEGER NOT NULL REFERENCES company_accounts(id), to_account_id INTEGER REFERENCES company_accounts(id), amount REAL NOT NULL, reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_no TEXT UNIQUE NOT NULL, party_id INTEGER NOT NULL REFERENCES parties(id), purchase_date TEXT NOT NULL, goods_description TEXT DEFAULT '', bags_qty REAL NOT NULL DEFAULT 0, invoice_no TEXT DEFAULT '', hsn TEXT DEFAULT '', gst_type TEXT DEFAULT 'NONE', gst_rate REAL NOT NULL DEFAULT 0, gst_taxable REAL NOT NULL DEFAULT 0, gst_amount REAL NOT NULL DEFAULT 0, gross_weight REAL NOT NULL, net_weight REAL NOT NULL, rate REAL NOT NULL, freight REAL NOT NULL DEFAULT 0, unload_charge REAL NOT NULL DEFAULT 0, moisture REAL NOT NULL DEFAULT 0, discount_pct REAL NOT NULL DEFAULT 0, driver_rokdi REAL NOT NULL DEFAULT 0, other_charges REAL NOT NULL DEFAULT 0, quality_deduct_per_mt REAL NOT NULL DEFAULT 0, gross_amount REAL NOT NULL, discount_amount REAL NOT NULL, quality_deduct_amount REAL NOT NULL, total_deduction REAL NOT NULL, net_payable REAL NOT NULL, status TEXT NOT NULL DEFAULT 'POSTED', notes TEXT DEFAULT '', payment_due_days INTEGER NOT NULL DEFAULT 0, payment_due_date TEXT DEFAULT '', truck_number TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_no TEXT UNIQUE NOT NULL, party_id INTEGER NOT NULL REFERENCES parties(id), payment_date TEXT NOT NULL, amount REAL NOT NULL, tds_rate REAL NOT NULL DEFAULT 0, tds_amount REAL NOT NULL DEFAULT 0, net_paid REAL NOT NULL DEFAULT 0, broker_name TEXT DEFAULT '', broker_email TEXT DEFAULT '', mode TEXT NOT NULL, company_account_id INTEGER REFERENCES company_accounts(id), bank_name TEXT DEFAULT '', utr TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', tds_base REAL NOT NULL DEFAULT 0, tds_rule TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payment_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE, purchase_id INTEGER NOT NULL REFERENCES purchases(id), amount REAL NOT NULL, UNIQUE(payment_id,purchase_id));
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES parties(id), entry_date TEXT NOT NULL, entry_type TEXT NOT NULL, reference_id INTEGER, reference_no TEXT, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, narration TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, details TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bank_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE, statement_date TEXT NOT NULL, statement_amount REAL NOT NULL, reference TEXT DEFAULT '', matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(payment_id));
CREATE TABLE IF NOT EXISTS bank_statement_imports(id INTEGER PRIMARY KEY AUTOINCREMENT,statement_hash TEXT NOT NULL UNIQUE,filename TEXT DEFAULT '',row_count INTEGER NOT NULL DEFAULT 0,created_by TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bank_statement_rows(id INTEGER PRIMARY KEY AUTOINCREMENT,import_id INTEGER NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,transaction_date TEXT NOT NULL,narration TEXT DEFAULT '',reference TEXT DEFAULT '',debit REAL NOT NULL DEFAULT 0,credit REAL NOT NULL DEFAULT 0,balance REAL,match_status TEXT NOT NULL DEFAULT 'UNMATCHED',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT UNIQUE NOT NULL, invoice_date TEXT NOT NULL, customer_name TEXT NOT NULL, customer_gstin TEXT DEFAULT '', place_of_supply TEXT DEFAULT '', invoice_type TEXT NOT NULL DEFAULT 'B2B', hsn TEXT DEFAULT '', description TEXT DEFAULT '', taxable_value REAL NOT NULL, discount_pct REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0, receivable_base REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 0, cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0, igst REAL NOT NULL DEFAULT 0, total_value REAL NOT NULL, status TEXT NOT NULL DEFAULT 'POSTED', due_days INTEGER NOT NULL DEFAULT 0, due_date TEXT DEFAULT '', cost_amount REAL NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, received_date TEXT DEFAULT '', received_amount REAL NOT NULL DEFAULT 0, receipt_account_id INTEGER REFERENCES company_accounts(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS financing_receivables (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL UNIQUE REFERENCES purchases(id), party_id INTEGER NOT NULL REFERENCES parties(id), bill_no TEXT NOT NULL, bill_date TEXT NOT NULL, cost_amount REAL NOT NULL, discount_amount REAL NOT NULL DEFAULT 0, other_charges_profit REAL NOT NULL DEFAULT 0, receivable_amount REAL NOT NULL, due_days INTEGER NOT NULL DEFAULT 0, due_date TEXT DEFAULT '', received_amount REAL NOT NULL DEFAULT 0, received_date TEXT DEFAULT '', receipt_account_id INTEGER REFERENCES company_accounts(id), status TEXT NOT NULL DEFAULT 'OPEN', notes TEXT DEFAULT '', tds_rate REAL NOT NULL DEFAULT 0, tds_amount REAL NOT NULL DEFAULT 0, net_received REAL NOT NULL DEFAULT 0, tds_section TEXT DEFAULT '', tds_reference TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS money_in (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_no TEXT UNIQUE NOT NULL, receipt_date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES company_accounts(id), amount REAL NOT NULL, receipt_type TEXT NOT NULL, party_id INTEGER REFERENCES parties(id), reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS money_out (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_no TEXT UNIQUE NOT NULL, payment_date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES company_accounts(id), amount REAL NOT NULL CHECK(amount > 0), out_type TEXT NOT NULL CHECK(out_type IN ('REFUND','LOAN_REPAYMENT','OTHER')), party_id INTEGER REFERENCES parties(id), loan_id INTEGER REFERENCES funding_loans(id), reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS interest_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_no TEXT UNIQUE NOT NULL, payment_date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES company_accounts(id), amount REAL NOT NULL, payee TEXT DEFAULT '', party_id INTEGER REFERENCES parties(id), reference_no TEXT DEFAULT '', narration TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS funding_loans (id INTEGER PRIMARY KEY AUTOINCREMENT, loan_no TEXT UNIQUE NOT NULL, lender_party_id INTEGER REFERENCES parties(id), lender_name TEXT NOT NULL, loan_start_date TEXT NOT NULL, principal_amount REAL NOT NULL, interest_type TEXT NOT NULL DEFAULT 'PERCENT', interest_rate REAL NOT NULL DEFAULT 0, fixed_interest_amount REAL NOT NULL DEFAULT 0, frequency TEXT NOT NULL DEFAULT 'MONTHLY', first_payment_date TEXT DEFAULT '', bank_name TEXT DEFAULT '', account_number TEXT DEFAULT '', ifsc TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS funding_schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id INTEGER NOT NULL REFERENCES funding_loans(id) ON DELETE CASCADE, due_date TEXT NOT NULL, interest_amount REAL NOT NULL, principal_due REAL NOT NULL DEFAULT 0, paid_amount REAL NOT NULL DEFAULT 0, paid_date TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'DUE');
CREATE TABLE IF NOT EXISTS funding_loan_transfers (id TEXT PRIMARY KEY, source_company_id INTEGER NOT NULL, destination_company_id INTEGER NOT NULL, source_loan_id INTEGER NOT NULL, destination_loan_id INTEGER, mode TEXT NOT NULL, transferred_principal REAL NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', payload TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reversed_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS import_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, row_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'IMPORTED');
  `);
  const addColumn=(table:string,column:string,definition:string)=>{const cols=d.prepare(`PRAGMA table_info(${table})`).all() as any[];if(!cols.some(c=>c.name===column))d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)};
  addColumn('money_out','destination_company_id','INTEGER'); addColumn('money_out','destination_receipt_id','INTEGER'); addColumn('company_settings','commercial_bill_settings',"TEXT NOT NULL DEFAULT '{}'"); addColumn('company_settings','payment_advice_settings',"TEXT NOT NULL DEFAULT '{}'"); addColumn('parties','email',"TEXT DEFAULT ''"); addColumn('parties','tds_enabled','INTEGER NOT NULL DEFAULT 0'); addColumn('parties','tds_section',"TEXT DEFAULT ''"); addColumn('parties','tds_rate','REAL NOT NULL DEFAULT 0'); addColumn('parties','party_type',"TEXT NOT NULL DEFAULT 'GOODS_VENDOR'"); addColumn('parties','entity_type',"TEXT NOT NULL DEFAULT 'OTHER'"); addColumn('parties','resident_status',"TEXT NOT NULL DEFAULT 'RESIDENT'"); addColumn('parties','pan_status',"TEXT NOT NULL DEFAULT 'VALID'"); addColumn('parties','tds_exempt','INTEGER NOT NULL DEFAULT 0'); addColumn('parties','opening_balance','REAL NOT NULL DEFAULT 0'); addColumn('parties','opening_balance_type',"TEXT NOT NULL DEFAULT 'PAYABLE'"); addColumn('parties','source_company_id','INTEGER DEFAULT NULL'); addColumn('parties','source_party_id','INTEGER DEFAULT NULL'); addColumn('parties','source_company_name',"TEXT DEFAULT ''"); addColumn('third_parties','source_company_id','INTEGER DEFAULT NULL'); addColumn('third_parties','source_third_party_id','INTEGER DEFAULT NULL'); addColumn('third_parties','source_company_name',"TEXT DEFAULT ''");
  addColumn('purchases','quality_deduct_rate_per_kg','REAL NOT NULL DEFAULT 0'); addColumn('purchases','broker_party_id','INTEGER'); addColumn('purchases','goods_description',"TEXT DEFAULT ''"); addColumn('purchases','bags_qty','REAL NOT NULL DEFAULT 0'); addColumn('purchases','invoice_no',"TEXT DEFAULT ''"); addColumn('purchases','hsn',"TEXT DEFAULT ''"); addColumn('purchases','gst_type',"TEXT DEFAULT 'NONE'"); addColumn('purchases','gst_rate','REAL NOT NULL DEFAULT 0'); addColumn('purchases','gst_taxable','REAL NOT NULL DEFAULT 0'); addColumn('purchases','gst_amount','REAL NOT NULL DEFAULT 0'); addColumn('purchases','payment_due_days','INTEGER NOT NULL DEFAULT 0'); addColumn('purchases','payment_due_date',"TEXT DEFAULT ''"); addColumn('purchases','godown_id','INTEGER'); addColumn('purchases','truck_number',"TEXT NOT NULL DEFAULT ''");
  // Stable sequential bill number. Existing entries are backfilled once in id order;
  // subsequent inserts allocate the next number inside the purchase transaction.
  addColumn('purchases','bill_number','INTEGER'); addColumn('godowns','capacity_qty','REAL NOT NULL DEFAULT 0'); addColumn('inventory_lots','batch_no',"TEXT DEFAULT ''"); d.prepare("UPDATE inventory_lots SET batch_no='B-'||COALESCE((SELECT sample_no FROM purchases WHERE purchases.id=inventory_lots.purchase_id),'LOT')||'-'||inventory_lots.id WHERE COALESCE(batch_no,'')=''").run();
  d.exec("UPDATE purchases SET bill_number=id WHERE bill_number IS NULL OR bill_number<=0");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_bill_number ON purchases(bill_number)");

  addColumn('saudas','purchase_entity_type',"TEXT NOT NULL DEFAULT 'PARTY'"); addColumn('saudas','purchase_entity_id','INTEGER'); addColumn('saudas','purchase_entity_name',"TEXT DEFAULT ''"); addColumn('saudas','selling_entity_type',"TEXT NOT NULL DEFAULT 'PARTY'"); addColumn('saudas','selling_entity_id','INTEGER'); addColumn('saudas','selling_entity_name',"TEXT DEFAULT ''"); addColumn('saudas','allocation_source',"TEXT DEFAULT ''"); addColumn('saudas','allocation_source_id','INTEGER'); addColumn('saudas','allocation_godown_id','INTEGER');
  d.exec("CREATE INDEX IF NOT EXISTS idx_inventory_godown ON inventory_lots(godown_id); CREATE INDEX IF NOT EXISTS idx_inventory_purchase ON inventory_lots(purchase_id); CREATE INDEX IF NOT EXISTS idx_inventory_batch ON inventory_lots(batch_no); CREATE INDEX IF NOT EXISTS idx_sauda_alloc_source ON sauda_allocations(source_type,source_id); CREATE INDEX IF NOT EXISTS idx_sauda_date ON saudas(sauda_date);");
  addColumn('company_settings','third_party_bill_settings',"TEXT NOT NULL DEFAULT '{}'");
  addColumn('payments','tds_rate','REAL NOT NULL DEFAULT 0'); addColumn('payments','tds_amount','REAL NOT NULL DEFAULT 0'); addColumn('payments','net_paid','REAL NOT NULL DEFAULT 0'); addColumn('payments','broker_name',"TEXT DEFAULT ''"); addColumn('payments','broker_email',"TEXT DEFAULT ''"); addColumn('payments','tds_base','REAL NOT NULL DEFAULT 0'); addColumn('payments','tds_rule',"TEXT DEFAULT ''"); addColumn('payments','company_account_id','INTEGER');
  addColumn('sales','due_days','INTEGER NOT NULL DEFAULT 0'); addColumn('sales','discount_pct','REAL NOT NULL DEFAULT 0'); addColumn('sales','discount_amount','REAL NOT NULL DEFAULT 0'); addColumn('sales','receivable_base','REAL NOT NULL DEFAULT 0'); addColumn('sales','due_date',"TEXT DEFAULT ''"); addColumn('sales','cost_amount','REAL NOT NULL DEFAULT 0'); addColumn('sales','received','INTEGER NOT NULL DEFAULT 0'); addColumn('sales','received_date',"TEXT DEFAULT ''"); addColumn('sales','received_amount','REAL NOT NULL DEFAULT 0'); addColumn('sales','receipt_account_id','INTEGER');
  addColumn('financing_receivables','notes',"TEXT DEFAULT ''"); addColumn('financing_receivables','other_charges_profit','REAL NOT NULL DEFAULT 0'); addColumn('financing_receivables','tds_rate','REAL NOT NULL DEFAULT 0'); addColumn('financing_receivables','tds_amount','REAL NOT NULL DEFAULT 0'); addColumn('financing_receivables','net_received','REAL NOT NULL DEFAULT 0'); addColumn('financing_receivables','tds_section',"TEXT DEFAULT ''"); addColumn('financing_receivables','tds_reference',"TEXT DEFAULT ''");
  d.prepare("UPDATE sales SET receivable_base=taxable_value+COALESCE(discount_amount,0) WHERE COALESCE(receivable_base,0)=0").run();
  d.prepare("UPDATE financing_receivables SET other_charges_profit=(SELECT COALESCE(other_charges,0) FROM purchases WHERE purchases.id=financing_receivables.purchase_id), receivable_amount=cost_amount+discount_amount+(SELECT COALESCE(other_charges,0) FROM purchases WHERE purchases.id=financing_receivables.purchase_id) WHERE COALESCE(other_charges_profit,0)=0 AND EXISTS(SELECT 1 FROM purchases WHERE purchases.id=financing_receivables.purchase_id AND COALESCE(purchases.other_charges,0)>0)").run();
  // Money-in receipts are cash inflows and must be CREDIT transactions.
  // Older builds incorrectly stored them as DEBIT, which made the payment API
  // calculate a different available balance than the dashboard. Normalize only
  // legacy MONEY_IN rows; reversals use reference_type=REVERSAL and are untouched.
  d.prepare("UPDATE account_transactions SET transaction_type='CREDIT' WHERE reference_type='MONEY_IN' AND transaction_type='DEBIT'").run();
  // Company-specific internal purchase bill numbering preference (safe for existing databases).
  const companySettingColumns = new Set((d.prepare('PRAGMA table_info(company_settings)').all() as any[]).map((c:any)=>String(c.name)));
  if (!companySettingColumns.has('purchase_bill_start_after')) d.exec('ALTER TABLE company_settings ADD COLUMN purchase_bill_start_after INTEGER NOT NULL DEFAULT 0');
  const purchaseColumns = new Set((d.pragma('table_info(purchases)') as any[]).map((c:any)=>String(c.name)));
  if (!purchaseColumns.has('truck_number')) d.exec("ALTER TABLE purchases ADD COLUMN truck_number TEXT NOT NULL DEFAULT ''");
  if (!companySettingColumns.has('discount_after_quality')) d.exec('ALTER TABLE company_settings ADD COLUMN discount_after_quality INTEGER NOT NULL DEFAULT 1');
  // v2.8.0: the discount base a purchase was saved with, so the register and the purchase form
  // always show the same figure after the company setting changes. NULL on legacy rows, which are
  // read with lib/utils.ts effectiveDiscountRule instead. No stored amount is modified.
  if (!purchaseColumns.has('discount_after_quality')) d.exec('ALTER TABLE purchases ADD COLUMN discount_after_quality INTEGER DEFAULT NULL');
  // v2.8.0: the conflict-resolution log and the conflict history are local audit artefacts, not
  // business data. They were being journalled and pushed (a resolution's before-image could make a
  // sync payload too large to accept), so any queued events for them are dropped once.
  try { d.exec("DELETE FROM sync_changes WHERE table_name IN ('sync_resolution_log','sync_conflict_history')"); } catch {}
  if((d.prepare('SELECT COUNT(*) c FROM company_settings').get() as any).c===0)d.prepare("INSERT INTO company_settings(id,entity_name) VALUES(1,'SOLIVY')").run();
  // v2.7.0: legacy bill-number renumbering is no longer automatic. It is reported by
  // lib/data-health.ts and applied only through the audited admin repair endpoint.
}


function ensureSyncSchema(d: Database.Database) {
  // Fast path: triggers were built for exactly this schema. Read-only, no file writes.
  try {
    const hasMeta = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_meta'").get();
    if (hasMeta) {
      const cols = d.prepare('PRAGMA table_info(sync_meta)').all() as any[];
      if (cols.some((c:any)=>c.name==='trigger_schema_version')) {
        const meta = d.prepare('SELECT trigger_schema_version v FROM sync_meta WHERE id=1').get() as any;
        if (meta && Number(meta.v) === Number(d.pragma('schema_version', { simple: true }))) return;
      }
    }
  } catch { /* fall through to full rebuild */ }
  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      id INTEGER PRIMARY KEY CHECK(id=1),
      device_id TEXT NOT NULL,
      suppress_triggers INTEGER NOT NULL DEFAULT 0,
      remote_cursor INTEGER NOT NULL DEFAULT 0,
      paired_url TEXT DEFAULT '',
      device_token TEXT DEFAULT '',
      sync_mode TEXT NOT NULL DEFAULT 'LIVE',
      paired_company_id INTEGER DEFAULT NULL,
      remote_device_id TEXT DEFAULT NULL,
      last_sync_at TEXT DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      table_name TEXT NOT NULL,
      pk_json TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
      base_json TEXT,
      row_json TEXT,
      origin_device TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      pushed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_changes_pushed ON sync_changes(pushed, seq);
    CREATE INDEX IF NOT EXISTS idx_sync_changes_created ON sync_changes(created_at);
    CREATE TABLE IF NOT EXISTS sync_applied_events (
      event_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sync_id_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_device_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      source_pk_json TEXT NOT NULL,
      destination_pk_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_device_id, table_name, source_pk_json)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_id_mappings_lookup ON sync_id_mappings(source_device_id, table_name);
  `);
  const syncMetaCols=d.prepare('PRAGMA table_info(sync_meta)').all() as any[];
  if(!syncMetaCols.some((c:any)=>c.name==='remote_device_id')) d.exec('ALTER TABLE sync_meta ADD COLUMN remote_device_id TEXT DEFAULT NULL');
  const cryptoId = () => crypto.randomUUID();
  const meta = d.prepare('SELECT device_id FROM sync_meta WHERE id=1').get() as any;
  if (!meta) d.prepare('INSERT INTO sync_meta(id,device_id) VALUES(1,?)').run(cryptoId());
  // Install change-capture triggers for existing business tables. System, identity,
  // licensing and sync tables are deliberately excluded from financial synchronization.
  const excluded = new Set(['sync_meta','sync_changes','sync_applied_events','sync_id_mappings','users','sqlite_sequence','schema_migrations','idempotency_keys','sync_device_acks','sync_resolution_log','sync_conflict_history','login_attempts']);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>;
  for (const {name} of tables) {
    if (excluded.has(name) || name.startsWith('license_') || name.startsWith('admin_')) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const cols = d.prepare(`PRAGMA table_info("${name}")`).all() as Array<{name:string;pk:number}>;
    const pk = cols.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk);
    if (!cols.length || !pk.length) continue;
    const obj = (prefix:string, selected=cols) => `json_object(${selected.map(c=>`'${c.name.replace(/'/g,"''")}', ${prefix}."${c.name}"`).join(',')})`;
    const pkObj = (prefix:string) => obj(prefix,pk);
    const safe = name.replace(/[^A-Za-z0-9_]/g,'_');
    const common = `INSERT INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed)
      SELECT lower(hex(randomblob(16))), '${name.replace(/'/g,"''")}', %PK%, '%OP%', %BASE%, %ROW%,
      (SELECT device_id FROM sync_meta WHERE id=1), 0
      WHERE COALESCE((SELECT suppress_triggers FROM sync_meta WHERE id=1),0)=0;`;
    d.exec(`DROP TRIGGER IF EXISTS sync_${safe}_ins; DROP TRIGGER IF EXISTS sync_${safe}_upd; DROP TRIGGER IF EXISTS sync_${safe}_del;`);
    d.exec(`CREATE TRIGGER sync_${safe}_ins AFTER INSERT ON "${name}" BEGIN ${common.replace('%PK%',pkObj('NEW')).replace('%OP%','INSERT').replace('%BASE%','NULL').replace('%ROW%',obj('NEW'))} END;`);
    d.exec(`CREATE TRIGGER sync_${safe}_upd AFTER UPDATE ON "${name}" BEGIN ${common.replace('%PK%',pkObj('NEW')).replace('%OP%','UPDATE').replace('%BASE%',obj('OLD')).replace('%ROW%',obj('NEW'))} END;`);
    d.exec(`CREATE TRIGGER sync_${safe}_del AFTER DELETE ON "${name}" BEGIN ${common.replace('%PK%',pkObj('OLD')).replace('%OP%','DELETE').replace('%BASE%',obj('OLD')).replace('%ROW%','NULL')} END;`);
  }
  if(!(d.prepare('PRAGMA table_info(sync_meta)').all() as any[]).some((c:any)=>c.name==='trigger_schema_version')) d.exec('ALTER TABLE sync_meta ADD COLUMN trigger_schema_version INTEGER DEFAULT NULL');
  d.prepare('UPDATE sync_meta SET trigger_schema_version=? WHERE id=1').run(Number(d.pragma('schema_version', { simple: true })));
}

/** True when a table exists, so a read can answer from it without creating it (v2.7.2). */
export function tableExists(d: Database.Database, name: string): boolean {
  try { return Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

/**
 * Record that the current schema generation already has its triggers, after DDL that cannot have
 * invalidated them (adding a bookkeeping table or column, never touching a synchronised table).
 * Without this, the next open rebuilds every synchronisation trigger — measured as 353 KB of
 * snapshot upload on the next read in online mode, for nothing.
 */
export function confirmSyncTriggers(d: Database.Database) {
  try {
    if (!(d.prepare('PRAGMA table_info(sync_meta)').all() as any[]).some((c: any) => c.name === 'trigger_schema_version')) return;
    d.prepare('UPDATE sync_meta SET trigger_schema_version=? WHERE id=1').run(Number(d.pragma('schema_version', { simple: true })));
  } catch { /* nothing to confirm */ }
}

function openDb(file:string){
  if(isVercel && process.env.SOLIVY_SQLITE_BRIDGE !== '1')throw new Error('SQLite storage is disabled on Vercel because its filesystem is not persistent. Configure DATABASE_URL and enable the SOLIVY Finance PostgreSQL database bridge before using this API online.');
  const key=path.resolve(file);
  if(!dbCache.has(key)){
    if(bridgeScope && !bridgeScope.allowed.has(key)){
      if(bridgeScope.allowCreate && !fs.existsSync(key)) bridgeScope.created.add(key);
      else throw new Error(`BRIDGE_SCOPE: ${path.basename(path.dirname(key))}/${path.basename(key)} is not loaded for this request.`);
    }
    fs.mkdirSync(path.dirname(key),{recursive:true});
    const d=new Database(key);
    d.pragma('journal_mode = WAL'); d.pragma('synchronous = FULL'); d.pragma('foreign_keys = ON'); d.pragma('busy_timeout = 5000');
    migrateIfNeeded(d,key);
    ensureSyncSchema(d);
    dbCache.set(key,d);
  }
  return dbCache.get(key)!;
}

/** Schema version for company/admin SQLite files. Bump when ensureSchema/applyV27Schema change. */
export const SCHEMA_VERSION = 28;
type BridgeScope = { allowed: Set<string>; allowCreate: boolean; created: Set<string> };
let bridgeScope: BridgeScope | null = null;
/** Set by the PostgreSQL bridge: only these files may be opened during the current request. */
export function setBridgeScope(files: string[] | null, allowCreate = false) {
  bridgeScope = files ? { allowed: new Set(files.map((f)=>path.resolve(f))), allowCreate, created: new Set() } : null;
}
export function bridgeCreatedFiles(): string[] { return bridgeScope ? [...bridgeScope.created] : []; }
export function isFileAccessible(file: string) { return !bridgeScope || bridgeScope.allowed.has(path.resolve(file)) || (bridgeScope.allowCreate && !fs.existsSync(path.resolve(file))); }

function migrateIfNeeded(d: Database.Database, file: string) {
  const current = Number(d.pragma('user_version', { simple: true }) || 0);
  if (current >= SCHEMA_VERSION) return;
  const hasData = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchases'").get();
  // Local installs: keep a restorable copy before touching an existing database.
  // Online: the bridge keeps the hydrated bytes and stores them in solivy_sqlite_snapshot_backups.
  if (hasData && !bridgeScope) {
    try {
      const dir = path.join(path.dirname(file), 'pre-migration-backups');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${path.basename(file, '.db')}-v${current}-to-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      d.prepare('VACUUM INTO ?').run(target);
    } catch (e) { console.error('SOLIVY pre-migration backup failed', e); throw new Error('Database upgrade stopped: a pre-migration backup could not be written. Free disk space and retry.'); }
  }
  const before = Number((d.prepare('SELECT total_changes() c').get() as any).c);
  ensureSchema(d);
  applyV27Schema(d);
  const rows = Number((d.prepare('SELECT total_changes() c').get() as any).c) - before;
  d.prepare('INSERT INTO schema_migrations(version,name,rows_affected) VALUES(?,?,?)').run(SCHEMA_VERSION, `upgrade from v${current}`, rows);
  if (hasData && current > 0 || rows > 0) {
    try { d.prepare("INSERT INTO audit_logs(username,action,entity,entity_id,details) VALUES('solivy-system','SCHEMA_MIGRATION','database',NULL,?)").run(JSON.stringify({ from: current, to: SCHEMA_VERSION, rows_affected: rows })); } catch {}
  }
  d.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** v2.7.0 additions: idempotency, migrations log, budgets, report favourites, document templates, indexes. */
function applyV27Schema(d: Database.Database) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, name TEXT NOT NULL, rows_affected INTEGER NOT NULL DEFAULT 0, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS idempotency_keys (idem_key TEXT PRIMARY KEY, route TEXT NOT NULL, username TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', response_status INTEGER, response_body TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
  CREATE TABLE IF NOT EXISTS budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, fiscal_year TEXT NOT NULL, account_code TEXT NOT NULL, month TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, notes TEXT DEFAULT '', updated_by TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(fiscal_year, account_code, month));
  CREATE TABLE IF NOT EXISTS report_favorites (username TEXT NOT NULL, report_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(username, report_id));
  CREATE TABLE IF NOT EXISTS document_preferences (scope TEXT NOT NULL, doc_type TEXT NOT NULL, template_id TEXT NOT NULL DEFAULT 'classic', theme TEXT NOT NULL DEFAULT '{}', updated_by TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(scope, doc_type));
  CREATE INDEX IF NOT EXISTS idx_purchases_party_status ON purchases(party_id, status, purchase_date);
  CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date, id);
  CREATE INDEX IF NOT EXISTS idx_payment_alloc_purchase ON payment_allocations(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_payments_party_status ON payments(party_id, status, payment_date);
  CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date, id);
  CREATE INDEX IF NOT EXISTS idx_ledger_party_date ON ledger(party_id, entry_date, id);
  CREATE INDEX IF NOT EXISTS idx_acct_tx_account ON account_transactions(account_id, transaction_date);
  CREATE INDEX IF NOT EXISTS idx_acct_tx_reference ON account_transactions(reference_type, reference_id);
  CREATE INDEX IF NOT EXISTS idx_fin_recv_status ON financing_receivables(status, bill_date);
  CREATE INDEX IF NOT EXISTS idx_fin_recv_party ON financing_receivables(party_id);
  CREATE INDEX IF NOT EXISTS idx_bank_matches_payment ON bank_matches(payment_id);
  CREATE INDEX IF NOT EXISTS idx_money_in_date ON money_in(receipt_date);
  CREATE INDEX IF NOT EXISTS idx_money_out_date ON money_out(payment_date);
  CREATE INDEX IF NOT EXISTS idx_money_out_loan ON money_out(loan_id, out_type, status);
  CREATE INDEX IF NOT EXISTS idx_funding_schedule_loan ON funding_schedule(loan_id, status, due_date);
  CREATE INDEX IF NOT EXISTS idx_tds_credit_source ON tds_credit_entries(source_transaction_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
  `);
}

export function closeAllDatabases(){ for (const d of dbCache.values()) { try { d.close(); } catch {} } dbCache.clear(); }

function legacyFile(mode:Mode){return path.join(dataDir,mode==='LIVE'?'live.db':'test.db')}
export function db(mode:Mode='LIVE',companyId=1){
  if(companyId===1){
    const target=legacyFile(mode);
    if(!fs.existsSync(target)){
      const projectLegacy=path.join(process.cwd(),'data',mode==='LIVE'?'live.db':'test.db');
      const oldExternal=path.join(path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'), 'AKSH-ENTERPRISE-FINANCE'),'data',mode==='LIVE'?'live.db':'test.db');
      const legacy=[projectLegacy,oldExternal].find(x=>path.resolve(x)!==path.resolve(target)&&fs.existsSync(x));
      if(legacy){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(legacy,target)}
    }
    return openDb(target)
  }
  return openDb(path.join(dataDir,'companies',String(companyId),mode==='LIVE'?'live.db':'test.db'));
}

const adminInitialized = new WeakSet<Database.Database>();
export function adminDb(){const d=openDb(path.join(dataDir,'admin.db'));if(adminInitialized.has(d))return d;adminInitialized.add(d);d.exec(`CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,code TEXT UNIQUE NOT NULL,address TEXT DEFAULT '',city TEXT DEFAULT '',state TEXT DEFAULT '',email TEXT DEFAULT '',gstin TEXT DEFAULT '',pan TEXT DEFAULT '',financial_year TEXT DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'DATA_ENTRY',password TEXT DEFAULT '',password_hash TEXT DEFAULT '',active INTEGER NOT NULL DEFAULT 1,menu_access TEXT NOT NULL DEFAULT '',card_access TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE TABLE IF NOT EXISTS user_companies(user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,can_live INTEGER NOT NULL DEFAULT 1,can_test INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,company_id));CREATE TABLE IF NOT EXISTS sync_devices(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,company_id INTEGER NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('LIVE','TEST')),user_id INTEGER NOT NULL,device_name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,last_seen_at TEXT DEFAULT NULL);CREATE TABLE IF NOT EXISTS password_reset_tokens(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT DEFAULT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);const addCompanyColumn=(column:string,definition:string)=>{const cols=d.prepare('PRAGMA table_info(companies)').all() as any[];if(!cols.some(c=>c.name===column))d.exec(`ALTER TABLE companies ADD COLUMN ${column} ${definition}`)};const addUserColumn=(column:string,definition:string)=>{const cols=d.prepare('PRAGMA table_info(admin_users)').all() as any[];if(!cols.some(c=>c.name===column))d.exec(`ALTER TABLE admin_users ADD COLUMN ${column} ${definition}`)};addUserColumn('menu_access',"TEXT NOT NULL DEFAULT ''");addUserColumn('card_access',"TEXT NOT NULL DEFAULT ''");addUserColumn('email',"TEXT NOT NULL DEFAULT ''");addCompanyColumn('address',"TEXT DEFAULT ''");addCompanyColumn('city',"TEXT DEFAULT ''");addCompanyColumn('state',"TEXT DEFAULT ''");addCompanyColumn('email',"TEXT DEFAULT ''");addCompanyColumn('gstin',"TEXT DEFAULT ''");addCompanyColumn('pan',"TEXT DEFAULT ''");addCompanyColumn('financial_year',"TEXT DEFAULT ''");addCompanyColumn('updated_at',"TEXT DEFAULT CURRENT_TIMESTAMP");const c=d.prepare('SELECT COUNT(*) c FROM companies').get() as any;if(!c.c)d.prepare("INSERT INTO companies(name,code) VALUES('SOLIVY','SOLIVY')").run();let defaultCompanyRow=d.prepare('SELECT id FROM companies WHERE code=?').get('SOLIVY') as any;if(!defaultCompanyRow){const legacyCompany=d.prepare('SELECT id FROM companies WHERE code=? OR UPPER(name)=UPPER(?) ORDER BY id LIMIT 1').get('AKSH','AKSH ENTERPRISE') as any;if(legacyCompany){d.prepare("UPDATE companies SET name='SOLIVY',code='SOLIVY',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(legacyCompany.id);defaultCompanyRow={id:legacyCompany.id};}else{d.prepare("INSERT INTO companies(name,code) VALUES('SOLIVY','SOLIVY')").run();defaultCompanyRow=d.prepare('SELECT id FROM companies WHERE code=?').get('SOLIVY') as any;}}const defaultCompany=defaultCompanyRow.id;const u=d.prepare('SELECT COUNT(*) c FROM admin_users').get() as any;if(!u.c&&isFileAccessible(legacyFile('LIVE'))&&fs.existsSync(legacyFile('LIVE'))){const old=db('LIVE',1);const oldUsers=old.prepare('SELECT username,name,role,active,password,password_hash FROM users').all() as any[];if(oldUsers.length){const ins=d.prepare('INSERT INTO admin_users(username,name,role,active,password,password_hash) VALUES(?,?,?,?,?,?)');for(const x of oldUsers)ins.run(x.username,x.name,x.role,x.active,x.password||'',x.password_hash||'')}/* New installations intentionally do not seed predictable administrator or tester credentials. The first administrator is created through /setup. */}
  // Disable known weak legacy plaintext defaults without resetting accounts that have modern password hashes.
  d.prepare("UPDATE admin_users SET active=0,password='',password_hash='' WHERE username='admin' AND password='admin123' AND COALESCE(password_hash,'')=''").run();
  d.prepare("UPDATE admin_users SET active=0,password='',password_hash='' WHERE username='tester' AND password='test123' AND COALESCE(password_hash,'')=''").run();
  // Reserved SOLIVY system identity: distinct, inactive, no password and no company grant (not a support backdoor).
  d.prepare("INSERT INTO admin_users(username,name,role,password,password_hash,active,menu_access,email) SELECT 'solivy-system','SOLIVY System Account','SYSTEM','','',0,'[]','' WHERE NOT EXISTS(SELECT 1 FROM admin_users WHERE username='solivy-system')").run();
  const admin=(d.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as any);const tester=(d.prepare("SELECT id FROM admin_users WHERE username='tester'").get() as any);if(admin)d.prepare('INSERT OR IGNORE INTO user_companies(user_id,company_id,can_live,can_test) VALUES(?,?,1,1)').run(admin.id,defaultCompany);if(tester)d.prepare('INSERT OR IGNORE INTO user_companies(user_id,company_id,can_live,can_test) VALUES(?,?,0,1)').run(tester.id,defaultCompany);applyAdminV27(d);ensureSyncSchema(d);return d;}

/** v2.7.0 admin additions: session revocation, audit trail, login throttling, no plaintext passwords at rest. */
function applyAdminV27(d: Database.Database) {
  d.exec(`CREATE TABLE IF NOT EXISTS admin_audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT,company_id INTEGER,mode TEXT,details TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS login_attempts(rate_key TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,reset_at INTEGER NOT NULL,blocked_until INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);`);
  // Any security-relevant change to a user ends that user's existing sessions (checked by lib/route-guard.ts).
  const nowMs = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_revoke_user_update'").get()) {
    d.exec(`CREATE TRIGGER trg_revoke_user_update AFTER UPDATE OF role, active, password_hash, password, menu_access, card_access, username ON admin_users BEGIN UPDATE admin_users SET sessions_revoked_at=${nowMs} WHERE id=NEW.id; END;
    CREATE TRIGGER trg_revoke_grant_insert AFTER INSERT ON user_companies BEGIN UPDATE admin_users SET sessions_revoked_at=${nowMs} WHERE id=NEW.user_id; END;
    CREATE TRIGGER trg_revoke_grant_update AFTER UPDATE ON user_companies BEGIN UPDATE admin_users SET sessions_revoked_at=${nowMs} WHERE id=NEW.user_id; END;
    CREATE TRIGGER trg_revoke_grant_delete AFTER DELETE ON user_companies BEGIN UPDATE admin_users SET sessions_revoked_at=${nowMs} WHERE id=OLD.user_id; END;`);
  }
  const cols = d.prepare('PRAGMA table_info(admin_users)').all() as any[];
  if (!cols.some((c:any)=>c.name==='sessions_revoked_at')) d.exec("ALTER TABLE admin_users ADD COLUMN sessions_revoked_at INTEGER NOT NULL DEFAULT 0");
  if (!cols.some((c:any)=>c.name==='failed_login_count')) d.exec("ALTER TABLE admin_users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0");
  // Hash any remaining legacy plaintext passwords once; afterwards plaintext login is impossible.
  const plain = d.prepare("SELECT id,password FROM admin_users WHERE COALESCE(password,'')<>''").all() as any[];
  if (plain.length) {
    const upd = d.prepare("UPDATE admin_users SET password_hash=CASE WHEN COALESCE(password_hash,'')='' THEN ? ELSE password_hash END,password='' WHERE id=?");
    d.transaction(()=>{ for (const r of plain) upd.run(hashLegacyPassword(String(r.password)), r.id); })();
    d.prepare("INSERT INTO admin_audit_logs(username,action,entity,details) VALUES('solivy-system','PLAINTEXT_PASSWORDS_HASHED','admin_users',?)").run(JSON.stringify({ count: plain.length }));
  }
}
function hashLegacyPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function resetMode(mode:Mode,companyId=1){
  const d=db(mode,companyId);
  const tables=['sauda_allocations','saudas','inventory_lots','bank_statement_rows','bank_statement_imports','bank_matches','payment_allocations','account_movements','funding_schedule','funding_loan_transfers','payments','interest_payments','money_in','money_out','ledger','financing_receivables','purchases','sales','account_transactions','godowns','company_accounts','bank_accounts','party_aliases','funding_loans','parties','third_parties','import_batches','audit_logs'];
  const tx=d.transaction(()=>{
    for(const t of tables) d.prepare(`DELETE FROM ${t}`).run();
    d.prepare("DELETE FROM sqlite_sequence WHERE name IN ("+tables.map(()=>'?').join(',')+")").run(...tables);
  });
  tx();
  try{ d.pragma('wal_checkpoint(TRUNCATE)'); }catch{}
}
export function resetTest(companyId=1){resetMode('TEST',companyId)}

// Clears only financial/transactional records while preserving master data,
// users, parties, bank accounts, company accounts and document settings.
// This is intentionally different from resetMode(), which is the destructive
// database purge used by the Admin backup/purge screen.
export function clearTransactionData(mode:Mode,companyId=1){
  const d=db(mode,companyId);
  const tables=['sauda_allocations','saudas','inventory_lots','bank_statement_rows','bank_statement_imports','bank_matches','payment_allocations','account_movements','funding_schedule','payments','interest_payments','money_in','money_out','ledger','financing_receivables','purchases','sales','account_transactions'];
  const tx=d.transaction(()=>{
    for(const t of tables) d.prepare(`DELETE FROM ${t}`).run();
    d.prepare("DELETE FROM sqlite_sequence WHERE name IN ("+tables.map(()=>'?').join(',')+")").run(...tables);
  });
  tx();
  // Transaction clearing removes principal repayment history, so preserved loan masters return to active status.
  d.prepare("UPDATE funding_loans SET status='ACTIVE'").run();
  try{ d.pragma('wal_checkpoint(TRUNCATE)'); }catch{}
}
export function backup(mode:Mode,companyId=1){return db(mode,companyId).serialize()}
export function adminDatabasePath(){return path.join(dataDir,'admin.db')}
export function appDataDirectory(){return dataDir}
export function databasePath(mode:Mode,companyId=1){return companyId===1?legacyFile(mode):path.join(dataDir,'companies',String(companyId),mode==='LIVE'?'live.db':'test.db')}
