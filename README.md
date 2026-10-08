# SOLIVY — Local Finance Manager

Local-first finance management system built with Next.js, Tailwind CSS and direct SQLite.

## Core features
- Separate LIVE and TEST SQLite databases
- Party master: address, GSTIN, PAN, primary bank details
- Configurable TDS per party (section + rate)
- Purchase/sample entry with weight, rate and deductions
- Quality deduction: net kg / 1000 × ₹/MT
- Vendor ledger
- Payments with broker name/email
- TDS calculation on payment settlement amount
- Automatic oldest-sample allocation
- Payment advice PDF branded **SOLIVY**
- Bank Matching
- Excel exports
- GST Filing register for outward sales / GSTR-1 working file
- Purchase GST fields for inward GST reconciliation
- User management
- TEST purge isolated from LIVE
- SQLite backup

## Windows
```powershell
npm install
npm run build
npm run dev
```
Open http://localhost:3000

Default users created per database:
- admin / admin123
- tester / test123

## Important GST note
The GST Filing module generates a structured outward-supply working workbook based on GSTR-1 data fields. The GST portal can change schemas and validations, so the workbook should be validated against the current GST portal/offline utility before filing. Direct portal filing requires an authorized GST API integration and credentials; this local app does not pretend to perform that without those credentials.

## Important TDS note
TDS is configurable by party because the applicable section/rate/threshold depends on the transaction and current tax rules. The app records the configured section/rate and calculates TDS on the payment settlement amount. Accountant/CA validation is recommended before statutory filing.


## v1.4 changes
- Responsive Tailwind UI across desktop/tablet/mobile.
- Party details appear immediately when selected in Purchase and Payment.
- Opening balance with Payable/Receivable type creates an OPENING ledger entry.
- Automatic goods-purchase TDS assistant based on current government threshold logic and company preceding-year turnover.
- Company/TDS Settings screen.

## v1.5 persistence and deployment

The SQLite files are no longer stored only beside the source code. By default the application uses a persistent user-data directory:
- Windows: `%APPDATA%\AKSH-ENTERPRISE-FINANCE\data\live.db` and `test.db`
- Linux/macOS: `~/.aksh-enterprise-finance/data/live.db` and `test.db`

Set `FINANCE_DATA_DIR` if you want a custom persistent volume. If an older project has `data/live.db` or `data/test.db`, the first startup automatically copies the legacy database into the new persistent location when the new file does not already exist.

The application now supports company bank/cash accounts with opening balances, account balances, scheduled vendor payables, scheduled customer receivables, receipt marking, and realised profit/margin.

### Hosting warning
This application uses a local SQLite file intentionally. For production online hosting, use a Node.js host with a persistent disk/volume and one durable database location, or migrate the database layer to PostgreSQL before using serverless hosting. Do not deploy the SQLite file as the only database on an ephemeral serverless filesystem.

## v1.6 persistence, payments and receivables
- LIVE and TEST databases are stored in the OS application-data directory so moving/re-extracting the source does not create a new database.
- Existing legacy `data/live.db` and `data/test.db` are copied on first startup if no persistent database exists.
- Multiple company bank/cash/OD accounts with opening balances are supported.
- Payment automatically generates a payment number when left blank and requires a selected bank/cash account for BANK/CASH payments.
- Payment due dates are calculated from purchase/bill date + payment days and shown as today, tomorrow and this-week dashboard items with party and bill/sample number.
- Customer receivables support due days, marking receipt, account balance updates, realised profit and margin.
- Sales discount percentage is stored and the requested business rule is applied as `receivable base = base sales value + discount amount`; edit is available before receipt.

## Online hosting
SQLite is deliberately used for local-first operation. Do not put the SQLite file on an ephemeral serverless filesystem. For an online production deployment, use a Node.js server with a persistent disk/volume or migrate the data layer to a managed PostgreSQL database. Vercel's own Next.js guidance uses a separate database service for persistent data rather than relying on the deployment filesystem.

## v1.7 finance workflow
- SQLite files default to `./data/live.db` and `./data/test.db`, so restarting/re-extracting the application does not silently create a fresh database in a different location.
- Existing databases from the previous `%APPDATA%\\AKSH-ENTERPRISE-FINANCE\\data` location are automatically copied on first startup when the new local database does not exist.
- Login is required. Passwords are upgraded to scrypt hashes on first successful login; new/changed passwords are hashed immediately.
- Purchase can create a financing receivable: `receivable = net payable + discount amount`. A different party can be selected as the receivable party.
- Receivables have due days from bill date, dashboard today/tomorrow/week reminders, receipt posting, account balance updates, editable agreed receivable amount before receipt, reversal, realised profit and margin.
- Payments show vendor outstanding and company bank/cash accounts and can be searched/reversed.
- Vendor ledger has search and date filters.
- Both LIVE and TEST databases can be purged, but the UI requires typing `PURGE LIVE` or `PURGE TEST` as an explicit confirmation.

## Online production warning
Do not deploy SQLite to Vercel/serverless ephemeral storage and assume it is durable. For an online production system, use a persistent Node.js/VPS disk or migrate the database layer to PostgreSQL. Set `SESSION_SECRET` to a long random value. Back up the database and restrict access to the login/API.

## Client local installation (Windows)
Run `INSTALL-SOLIVY-LOCAL.bat`. The installer checks for Node.js and, where Windows Package Manager is available, installs the Node.js LTS runtime automatically. `better-sqlite3` bundles the SQLite engine; the client does not need a separate SQLite installation. The installer asks where financial data should be stored and writes `FINANCE_DATA_DIR` to `.env.local`. The database is therefore outside the application folder. It also creates a desktop shortcut and builds the Next.js production bundle.

Default fresh company: **SOLIVY**. Default administrator: `admin / admin123` (change this immediately after first login).

## Purge
Only an authenticated **ADMIN** can purge LIVE or TEST. The confirmation phrase must exactly match `PURGE LIVE` or `PURGE TEST`. Purge now clears financial/master transaction tables, including money-in, interest payments, funding loans/schedules, imports, payments, allocations, purchases, receivables, accounts and ledgers, and resets their SQLite sequences. It does not delete the application or the database file itself.
