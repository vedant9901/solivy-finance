# SOLIVY Finance v2.5.11 — Responsive + Security Hardening

This build preserves the v2.5.10 withdrawal/transfer business logic and adds defensive hardening.

## UI / responsive
- Header controls use a mobile-first Tailwind grid and switch to a compact flex layout at `sm`.
- Shared `Table` renders desktop tables from `md` upward and mobile stacked cards below `md`.
- Long values wrap instead of forcing the viewport wider.
- Mobile module selector remains sticky and full width.
- Existing Tailwind v4 setup is preserved.

## Authentication / authorization
- Session secret is resolved at request time and production fails closed if it is missing.
- Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` only when the actual request is HTTPS. This keeps local production-mode login working on `http://localhost` while securing HTTPS deployments.
- Signed sessions have a 12-hour expiry.
- Password verification uses scrypt and timing-safe comparison.
- Login attempts are rate-limited: 5 failures within the window triggers a temporary block.
- TESTER accounts are forced to TEST mode server-side.
- VIEWER accounts are read-only server-side.
- Administrative/destructive endpoints are blocked server-side for non-ADMIN roles.
- Company identity is taken from the signed session and injected by middleware; browser-supplied company headers cannot override it.
- TEST → LIVE uses the session company instead of a browser-supplied company ID.

## Web security
- Same-origin protection for state-changing API requests.
- Request body limits: 10 MB for normal API mutations and 25 MB for finance imports.
- CSP, HSTS on HTTPS, frame protection, MIME sniffing protection, strict referrer policy, cross-origin isolation/resource policy, permissions policy, robots noindex and no-store cache headers.
- Default Next powered-by header remains disabled.

## Information exposure
- Non-admin `/api/data` no longer receives the complete administrator/user list or all company records. It receives only assigned companies.

## Static verification included
- TypeScript/TSX parse audit.
- Local relative-import resolution audit.
- API route handler audit.
- Tailwind dependency/import audit.
- Security configuration audit.
- Icon-package import audit.

## Important deployment note
This source is SQLite + better-sqlite3 and is designed for a persistent single-instance deployment. Do not put the SQLite database on an ephemeral serverless filesystem. For a Vercel/serverless online deployment, the database layer must use a managed server database such as PostgreSQL.

No application can honestly be guaranteed to be “unhackable”. This build adds the major application-layer protections available without changing the financial business logic or replacing the SQLite architecture.

## Verification performed in the build workspace
- 47 TypeScript/TSX source files parsed successfully with the TypeScript compiler parser.
- 47 source files passed local relative-import resolution.
- 38 API route handlers checked and each exposes at least one supported HTTP handler.
- Security/responsive audit passed.
- ZIP integrity test passed.
- Full `npm install` / `next build` was attempted twice in the isolated build workspace but dependency installation timed out, so a successful production build is **not** claimed here.
