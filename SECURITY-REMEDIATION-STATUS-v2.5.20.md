# SOLIVY Finance v2.5.20 — Security Remediation Candidate

Date: 10 October 2026

## Important status

This is a **source-level remediation candidate**, not a production-certified build. It has not been installed on a clean Windows PC, and a full Next.js production build, dynamic security tests, database restore drills, and Vercel deployment tests have not been run. Do not use it for high-value customer finance records until the remaining release gates pass.

## Changes made in this candidate

1. **Removed new-install default credentials.** Fresh databases no longer seed `admin/admin123` and `tester/test123`. Login no longer accepts those well-known default password pairs. Existing installs are not automatically deleted or reset.
2. **Added first-run administrator setup.** `/setup` creates the first administrator only if there are no users. It requires a unique username, valid admin email, and password of at least 12 characters. Passwords are stored using the existing scrypt helper. It does not reset existing user data.
3. **Bound ordinary finance routes to session LIVE/TEST mode.** A new `sessionMode(req)` helper reads the trusted mode header injected by middleware. Common finance handlers were changed not to select mode from body/query values. Explicit login and environment-switch requests remain user-selected and are checked against company permissions.
4. **Added server-side menu entitlement checks.** The signed session carries the user's menu IDs and middleware maps protected API prefixes to module IDs. Admin role remains exempt from menu locks, while existing administrator-only route rules remain.
5. **Added password recovery flow.** Reset tokens are random, stored as SHA-256 hashes, expire after 30 minutes, and are single-use. Passwords are re-hashed with scrypt. Email delivery uses the Resend API and requires environment configuration.
6. **Extended smoke checks** for the new setup, mode helper, menu entitlements, and password-reset token properties.

## Password recovery configuration

Configure these only in a trusted server environment:

- `RESEND_API_KEY`
- `MAIL_FROM`
- `SOLIVY_ADMIN_EMAIL`
- `APP_BASE_URL`

The target organization must have its email address configured in company settings. Do not embed an email-provider API key in a distributable client package. For offline-only client installs, password recovery needs a vendor-controlled support/recovery procedure or a secure private relay; the local app must not be shipped with a shared email API secret.

## Still NOT solved / NOT verified

- **Immediate session invalidation after password reset/logout is not implemented.** Signed stateless sessions can remain valid until expiry. A server-side session registry/version check or an online revocation service is still required.
- **Licensing is not implemented in this candidate.** There is no completed signed offline license issuer/validator or online subscription entitlement service. Do not claim license enforcement exists yet.
- **Online Vercel + Neon deployment has not been changed or audited here.** This uploaded source uses SQLite (`better-sqlite3`). The actual Vercel source/branch and PostgreSQL adapter must be supplied/reviewed separately.
- Company-scoped API authorization still needs a dynamic route-by-route test suite, especially direct requests, exports, backup, admin operations, company switching, and role changes.
- Backup restoration, upgrade rollback, record preservation, and SQLite integrity were not dynamically tested.
- Dependency vulnerability scan, secret scan, full typecheck/build, clean Windows install, and browser end-to-end tests remain outstanding.
- The in-memory login rate limiter is not a sufficient distributed rate limiter for a multi-instance online deployment.
- Local SQLite data is not encrypted at rest by this candidate.

## Email and license operations

An offline license must be issued per customer by SOLIVY using a private signing key that never ships in the client installer. The local app verifies the signed license with a public key. Online licensing should be enforced by the Vercel server on login and protected API operations. Neither path is implemented in this candidate; issuing a license file alone would not make it enforced.

## Validation performed in this environment

- TypeScript/TSX syntax transpile check: passed for 53 files using the globally installed TypeScript compiler.
- Existing and extended source/security smoke checks: passed.
- Relative import path existence scan: passed at the time of inspection.
- Full `npm ci`, production build, runtime API tests, Windows installer tests, penetration testing, and Vercel/Neon tests: **not run**.

A passing source smoke check is not a security certification.
