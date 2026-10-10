# SOLIVY Finance v2.5.14 — Local Session Secret Startup Fix

This patch fixes local production startup when `SESSION_SECRET` is absent or left as the example placeholder.

- `npm start` now runs `scripts/ensure-local-secret.cjs` before `next start`.
- The script preserves other `.env.local` values and only generates a new secret when missing, too short, or clearly a placeholder.
- The secret is written locally and Next.js loads it from `.env.local`; middleware and API routes therefore use the same value.
- Existing valid secrets are preserved. If a new secret is generated, active sessions may need to log in again.
- This is a local-start safeguard; Vercel still requires `SESSION_SECRET` to be set in project Environment Variables.
- Never commit `.env.local` or share its contents.
