# SOLIVY Finance v2.5.67 — Online Login / New Organization Fix

## Problem
Online login could reject an existing user for a newly-created organization when the deployment enabled the optional native PostgreSQL authentication path. Company creation and user-company assignments were saved through the PostgreSQL-backed SQLite snapshot bridge, while login could read a separate native PostgreSQL set of tables. This created two sources of truth.

## Fix
- Online and offline login now use the same `adminDb()` authentication path. On Vercel, the existing PostgreSQL/SQLite bridge hydrates and persists this database.
- Login still requires an active user, active organization, valid password, and explicit `user_companies` permission for the selected LIVE or TEST environment.
- Username lookup is case-insensitive to avoid a case mismatch between an existing account and the login form.
- Company creation continues to require explicit user assignment for non-admin users; this avoids silently granting every existing user access to every new organization.

## Deployment and verification
Run `npm install`, `npm run check:online-login-org`, `npm run check:database-bridge`, `npm run check:security`, and `npm run build` before deployment. In Administration → Companies, explicitly assign the existing user LIVE and/or TEST access for the new organization. The user must select the same environment to which they were assigned.
