# SOLIVY Finance v2.5.22 — License Management

## In-app module

- Admin-only `License Management` menu, visible regardless of the selected organization.
- Organization list covers every row in the admin database.
- Shows license status, organization name, licensed customer, license ID, edition, issue date, expiry date, days remaining/expired, and included/excluded module features.
- The status endpoint validates the Ed25519 signature with the embedded public key before displaying license payload details.
- No private signing key is present in the app or sent to the browser.

## Expired license behavior

An authenticated `ADMIN` can load `/` and access the License Management module after the license is expired, missing, invalid, or not assigned. This does not deactivate the admin account. Financial APIs remain blocked by middleware until a valid license is configured. Non-admin users do not receive the recovery exception.

## Renewing online licenses

Issue a signed token using the owner-only CLI, update the appropriate company ID in `SOLIVY_LICENSES_JSON` in Vercel, then redeploy. The UI is read-only for issuance/renewal; it never signs licenses in the browser.

## Production caveat

This build still uses SQLite in `lib/db.ts`. Vercel serverless filesystem storage is not a durable shared database. A production multi-organization online deployment should use a persistent shared database/service before relying on the license overview as the system of record.
