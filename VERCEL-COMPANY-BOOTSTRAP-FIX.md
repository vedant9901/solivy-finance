# v2.6.0 Vercel Company Bootstrap Fix

## Online Vercel setup
Set these Vercel Production environment variables:
- `DATABASE_URL` = complete Neon PostgreSQL connection string
- `SESSION_SECRET` = strong random secret
- `DEPLOYMENT_MODE` = `online`

The first request to `/api/login-companies` initializes the `solivy_admin` schema in PostgreSQL inside a transaction, creates the SOLIVY company, admin/test users, and company access rows. It then returns the company list.

## Default online login
- Company: SOLIVY
- Username: admin
- Password: admin123

Change the password immediately after first login.

## Offline
Offline remains SQLite-based. The installer sets `DEPLOYMENT_MODE=offline`; it does not use Neon.
