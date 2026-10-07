# SOLIVY Finance v2.7.0 — Security & Validation Hardening

## Included

- Role enforcement at the application gateway for administrator-only operations.
- VIEWER users are read-only at the API gateway.
- TEST/LIVE access remains tied to the signed session and company assignment.
- Browser-supplied company headers are overwritten by the authenticated session context.
- API cache disabled for authenticated financial endpoints.
- HSTS, frame protection, MIME sniffing protection, referrer and permissions headers.
- Request-size limits (15 MB import limit; 2 MB for other API requests).
- Login attempt throttling with a 15-minute temporary lock after repeated failures.
- Stronger username and password validation for new users.
- Financial amount normalization rejects NaN/Infinity and prevents negative purchase deductions.
- Purchase dates validated as YYYY-MM-DD and GST rates capped at 100%.
- All shared application tables now have client-side clickable sorting on every column.
- Commercial bill total uses the stored accounting `net_payable`, which includes freight and all persisted deductions.
- Payment advice redesigned to omit empty optional fields and to use the current company master name.

## Important security note

No software can honestly guarantee that nobody can ever hack it. This release hardens the application against common authentication, authorization, injection, malformed-input, accidental-data-change and browser-level attack paths. Keep Vercel, Neon, Windows and customer PCs patched and keep `SESSION_SECRET` and `DATABASE_URL` private.

## Production secrets

- `SESSION_SECRET` must be a long random secret.
- `DATABASE_URL` must never be committed to Git.
- Do not expose customer database backups publicly.
- Change bootstrap credentials after first deployment.
