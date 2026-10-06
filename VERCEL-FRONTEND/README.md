# SOLIVY Finance v2.6.0 — Vercel Frontend

This folder is the **browser/frontend-only** deployment package for Vercel.

It intentionally contains **no `app/api` directory and no SQLite database code**.
All `/api/*` requests are reverse-proxied by Next.js to `SOLIVY_BACKEND_URL`.

## Architecture

Browser → Vercel frontend → private SOLIVY API server → persistent SQLite

This lets the same accounting/API code remain on a server while the client receives only the web UI. The offline package at the repository root remains fully local.

## Vercel environment variables

- `SOLIVY_BACKEND_URL` = your HTTPS backend URL
- `SESSION_SECRET` = the exact same secret used by the backend

Do not prefix either variable with `NEXT_PUBLIC_`.

## Important

Vercel is the frontend host in this architecture. The current SQLite/API application must run on a persistent server (VPS, Docker host, etc.). Do not deploy the SQLite API directly as a Vercel serverless function.
