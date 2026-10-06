# Production hardening v2.5

## Financial data
- SQLite uses WAL, synchronous=FULL, foreign keys and busy timeout.
- Financial data lives outside the application directory by default.
- LIVE and TEST remain separate databases.
- TEST→LIVE refuses to overwrite a non-empty LIVE database.
- CSV import is idempotent by Party + Bill No + Bill Date; re-importing the same bill skips the existing record.
- CSV import uses Amount Paid as historical cost when present, otherwise Amount to be paid; Amount To Receive is the receivable; actual Amount Receive only controls realised receipt/profit. It does not create a duplicate bank/cash transaction because the CSV does not identify the bank account.
- Every posted financial operation should use a database transaction and reversal rather than destructive deletion.

## Authentication
- Passwords are stored with scrypt hashes.
- Sessions are HTTP-only, signed HMAC cookies.
- Production requires SESSION_SECRET; the insecure development fallback is not used when NODE_ENV=production.
- Middleware injects the authenticated company, role, user and environment into server-side request headers.
- Admin-only APIs check the server-side role.
- Security response headers are applied.

## Important limitation
No software can honestly be described as “non-hackable”. Before internet exposure, use HTTPS, a strong random SESSION_SECRET, OS-level account permissions, encrypted/offline backups, firewall restrictions, regular restore tests, and preferably a managed PostgreSQL database for multi-instance/cloud deployment.
