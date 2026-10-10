# SOLIVY Finance v2.5.21 — Release QA Record

Date: 10 October 2026
Baseline: user-provided working v2.5.19 client release source, plus the previously prepared v2.5.20 security-remediation changes, versioned as v2.5.21.

## Checks run in this environment

- PASS — TypeScript/TSX source parse audit: 55 files checked (`node scripts/check-source.cjs`).
- PASS — Security/source smoke checks (`node scripts/check-security.cjs`). These are static assertions, not a penetration test.
- PASS — Import integrity checks: 6 checks (`node scripts/check-import-schema.mjs`).
- PASS — Ed25519 license signing/verification self-test (`node scripts/license-tool.cjs self-test`).
- PASS — Test license token generated using the vendor key; signature verified with the public key embedded in middleware.
- PASS — WebCrypto Ed25519 signature verification in the current Node runtime.
- PASS — Node syntax checks for the license CLI and check scripts.

## Checks not completed

- BLOCKED — `npm install --no-audit --no-fund` timed out in the available environment.
- NOT RUN — Full `next build` / standalone production bundle.
- NOT RUN — PowerShell script execution on Windows or clean-PC installation.
- NOT RUN — Runtime SQLite migration test against a copy of a customer's existing database.
- NOT RUN — Backup restore and upgrade rollback test.
- NOT RUN — Dynamic company-isolation, LIVE/TEST attack, reset-session invalidation, and authorization tests.
- NOT RUN — Live Vercel environment and database adapter test.
- NOT RUN — `npm audit` / external secret scanner.

## Release decision

This package is a **commercial-hardening candidate**, not a production-certified final build. Do not replace a customer's only installation or use it with high-value real financial records until the blocked/not-run checks are completed. Keep a verified backup and test upgrades against a database copy first.

## Licensing scope

- Signed Ed25519 tokens are verified in middleware when `SOLIVY_LICENSE_ENFORCEMENT=required`.
- Token validity includes product, issue time, expiry, company ID, and signature checks.
- The token's feature list is checked against the mapped API route feature. Unmapped API routes require the `core` feature.
- Offline launcher sets enforcement to `required` and passes the per-customer token to the app process.
- Online Vercel enforcement requires `SOLIVY_LICENSE_ENFORCEMENT=required` and `SOLIVY_LICENSES_JSON` mapping company IDs to signed tokens (or one `SOLIVY_LICENSE_TOKEN` for a dedicated deployment).
- Online license-map updates require a Vercel environment update/redeployment. This is not a self-service billing dashboard or immediate online revocation service.
- The signing private key is not in the source/client release ZIP; it is delivered separately to the owner and must never be sent to customers.

## Important known gap

The current signed stateless session design does not yet provide immediate server-side revocation of a copied session after password reset. Reset links are hashed, single-use and expiring, but a previously stolen session token may remain valid until its cookie expires. Do not describe this as fully secure until server-side session revocation is implemented and tested.
