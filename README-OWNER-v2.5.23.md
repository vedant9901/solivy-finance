# SOLIVY Finance v2.5.23 — Owner / Developer README

## Status
This is a **commercial-hardening candidate**, not a certified or penetration-tested product. It preserves the existing Next.js finance UI and SQLite-based local workflows. Do not call it production-secure until clean Windows, Vercel, backup/restore, and security tests pass.

## Distinct SOLIVY system identity
- The app ensures the `SOLIVY` organization exists.
- It also ensures a distinct `solivy-system` account exists in the admin database. This reserved `SYSTEM` identity is inactive, has no password and has no company grant. It cannot log in and is not a support backdoor.
- Known legacy plain defaults `admin/admin123` and `tester/test123` are disabled. Existing accounts with modern password hashes are not reset automatically.
- Both the source installer and client installer generate unique per-install session and one-time setup secrets using the operating-system cryptographic RNG. Use `/setup` to create the real administrator with a 12+ character password.

## Licensing
The app verifies Ed25519-signed license tokens in middleware. The public key is embedded in `middleware.ts` and duplicated in the admin-only license status API for display-time signature verification; the private signing key is vendor-only.

### Private key handling
The file `private.pem` delivered separately is the signing authority for this build. Store it offline/encrypted. Never send it to a client, commit it, or place it in the client release ZIP. Anyone who obtains it can issue valid licenses. Back it up securely.

### Issue an offline license
```powershell
node scripts/license-tool.cjs issue --private-key "C:\SOLIVY-Keys\private.pem" --customer "Customer Legal Name" --company-ids 1 --days 365 --edition professional --features core,dashboard,accounts,account-movements,parties,purchase,payments,money-in,interest,funding,import,ledger,receivables,reports,bank,backup,gst,commercial-bills,document-settings,settings --out .\customer-license.txt
```
Use the actual company ID. For a perpetual license, use this command pattern:

```powershell
node scripts/license-tool.cjs issue --private-key "C:\SOLIVY-Keys\private.pem" --customer "Customer Legal Name" --company-ids 1 --perpetual --edition professional --features '*' --out .\customer-perpetual-license.txt
```

The signed payload uses `perpetual: true` and `expiresAt: null`. A perpetual offline token cannot be remotely revoked after delivery. `--company-ids *` is only for a dedicated single-customer installation; never use wildcard licenses on a shared server. Send only the token/file, not the private key.

### Local development license configuration
After generating a token, add `SOLIVY_LICENSE_ENFORCEMENT=required` and `SOLIVY_LICENSE_TOKEN=PASTE_FULL_TOKEN` to `.env.local` for a single organization, or use `SOLIVY_LICENSES_JSON={"1":"TOKEN1","2":"TOKEN2"}` for multiple company IDs. Restart Next.js after changing environment variables. The token's `--company-ids` must include the active company ID. The local license status page reads these environment variables too, even when enforcement is off.

### Online Vercel license setup
Set `SOLIVY_LICENSE_ENFORCEMENT=required`, a unique `SESSION_SECRET`, a unique `SOLIVY_SETUP_SECRET`, and `SOLIVY_LICENSES_JSON` in Vercel. The JSON is a map from company IDs to their tokens, for example `{"1":"TOKEN1","2":"TOKEN2"}`. Tokens must be signed for the matching company IDs. Updating the map requires a Vercel environment update/redeploy. This is not a self-service licensing dashboard and online revocation is not immediate until the new map is deployed. A proper shared PostgreSQL licensing service is still needed for automated billing and real-time revocation.

### Key rotation
Rotating keys requires updating the public key in both `middleware.ts` and `app/api/license/status/route.ts`, then shipping a new build. Existing licenses signed by an old key will no longer verify unless a dual-key transition is implemented. Do not rotate casually.

## Build client release
On Windows, run `BUILD-CLIENT-RELEASE.bat`. It runs checks and creates a standalone production package under `releases`. Send only that client ZIP and the signed license token. Never send source ZIPs, `.env`, Git metadata, database files, or the private key. Client installs may require internet to install Node.js LTS the first time. The bundle reduces accidental source sharing but JavaScript can be inspected by a determined user.

## Data and upgrades
Local data/config are stored under `%APPDATA%\SOLIVY-FINANCE`, outside the replaceable application directory. Back up this entire folder before each upgrade. The current scripts do not prove restore/rollback correctness; test using a copy of data and compare row counts and critical balances before and after.

## Remaining production gates
1. Clean Windows production build/install/update test.
2. API tests for cross-company and LIVE/TEST isolation.
3. Verify reset-token expiry/reuse, email delivery, and session invalidation. Password reset invalidates reset tokens, but copied stateless sessions may remain valid until expiry; immediate revocation is not yet proven.
4. Run `npm audit`, secret scanning, type checking, integration tests and production build.
5. Test backup restoration and upgrade rollback.
6. Audit the actual Vercel deployment and its real database adapter independently. This ZIP uses SQLite; it does not by itself prove Neon/PostgreSQL persistence or multi-tenant safety.
7. Test license expiry, bad signatures, wrong company IDs, missing token, the new admin-only License Management page, and all protected APIs. Verify that admins can reach renewal information after expiry while financial APIs remain blocked. Feature arrays are displayed in the dashboard; verify that each listed feature is enforced by its mapped API route before differentiated module plans are sold.

## Honest security statement
This is not a penetration-test certificate. Static checks do not guarantee security. Do not store high-value real financial data or advertise “fully secure” until the tests above pass and an independent security review is completed.
