# SOLIVY Finance v2.6.0 Deployment

## Offline Windows

Use the existing local installer/start scripts. Data remains under the persistent SOLIVY data directory and uses SQLite.

## Vercel + Neon (frontend + backend in one project)

1. Create a Neon PostgreSQL project.
2. Copy the complete Neon connection string.
3. Push the root SOLIVY Finance project to GitHub.
4. Import that repository into Vercel as a Next.js project.
5. In Vercel → Settings → Environment Variables add:
   - `DATABASE_URL` = complete Neon connection string
   - `SESSION_SECRET` = strong random value
   - `DEPLOYMENT_MODE` = `online`
6. Enable the variables for Production (Preview is recommended too).
7. Deploy.
8. Open the generated `*.vercel.app/login` URL.
9. On first request, the application initializes the PostgreSQL schemas and SOLIVY company/admin records.
10. Test login, accounts, vendor, purchase, payment, vendor outstanding, withdrawal and transfer before importing real data.

### Do not add
- `NEXT_PUBLIC_DATABASE_URL`
- `NEXT_PUBLIC_SESSION_SECRET`
- `FINANCE_DATA_DIR` on Vercel
- SQLite `.db` files to GitHub

### Security
Server-side secrets stay in Vercel Environment Variables. The browser receives only the frontend bundle; Next.js API/business logic runs server-side.
