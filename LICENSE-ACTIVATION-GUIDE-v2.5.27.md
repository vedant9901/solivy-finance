# SOLIVY Finance v2.5.27 — License Activation Guide

This guide covers issuing a signed license, activating a fresh Windows client, adding another organization, replacing a license, and configuring online licensing. Never send the signing private key to a client.

## 1. License concepts

- **Owner/developer PC:** contains the source project and the private Ed25519 signing key.
- **Client PC:** receives only the compiled client release and the signed token.
- **Company ID:** the numeric `companies.id` in the database used by that installation. A local SQLite ID and an online PostgreSQL ID may differ.
- **Token:** a signed string with two dot-separated parts. Two parts only confirms its shape; it does not prove that its signature, expiry, or company assignment is valid.
- **Public key:** must match the private key used to issue the token. The public key embedded in this v2.5.27 build is:
  `MCowBQYDK2VwAyEAInUktjI0jjuAmYTDfkOjKCiVopMVI3Gaa4cmxnwV1PQ=`
  (Use the exact key embedded in the actual build; do not change it casually.)

## 2. Prepare the owner PC

1. Extract the source/build package to a normal project folder.
2. Open PowerShell in that folder (the folder should contain `scripts\license-tool.cjs`).
3. Confirm the tool exists:
   ```powershell
   Test-Path .\scripts\license-tool.cjs
   ```
   It must return `True`. If PowerShell opens in `C:\Windows\System32`, first `cd` to the project folder.
4. Verify the owner private key exists and is the key for this build. Do not print or send the private key:
   ```powershell
   $privateKey = "D:\Personal\finance-manager-KEYS\private.pem"
   Test-Path $privateKey
   node -e "const c=require('crypto'),f=require('fs');const k=c.createPrivateKey(f.readFileSync(process.argv[1]));console.log(c.createPublicKey(k).export({type:'spki',format:'der'}).toString('base64'))" $privateKey
   ```
   Compare the output with the exact embedded public key shown above. If it differs, stop: tokens from that key will fail signature verification in this build. Do not generate a replacement key unless you are prepared to update/rebuild every relevant app and manage existing licenses.
5. Run the signing tool self-test:
   ```powershell
   node .\scripts\license-tool.cjs self-test
   ```
   Expected: `PASS Ed25519 time-limited and perpetual sign/verify self-tests`.

## 3. Issue a customer license

Before issuing a token, determine the customer's **actual numeric company ID** in the database used by the installation. Do not guess it. For a local client, inspect that client's organization list. For online, inspect the PostgreSQL database.

Example for a 365-day Professional license for company ID 1:
```powershell
node .\scripts\license-tool.cjs issue --private-key "D:\Personal\finance-manager-KEYS\private.pem" --customer "Aarsh Enterprise" --company-ids 1 --days 365 --edition professional --features "core,dashboard,accounts,account-movements,parties,purchase,payments,money-in,interest,funding,import,ledger,receivables,reports,bank,backup,gst,commercial-bills,document-settings,settings" --out ".\Aarsh-Client-License.txt"
```
Change the customer, ID, modules, and duration as required. The `--features` list must contain supported feature IDs. Use `--company-ids 1,2` to authorize both IDs in one token. Avoid `--company-ids '*'` and `--features '*'` for normal multi-customer licensing; wildcard access is broad.

A perpetual license is issued only when intentionally approved:
```powershell
node .\scripts\license-tool.cjs issue --private-key "D:\Personal\finance-manager-KEYS\private.pem" --customer "Customer Name" --company-ids 1 --perpetual --edition professional --features "core,accounts,payments,reports" --out ".\Customer-Perpetual-License.txt"
```
Perpetual offline licenses cannot be remotely revoked by this token system. Treat the token as a credential.

The generated text file contains the license token. Send only the token to the client through a secure channel. Never send `private.pem`, source code, or your key folder.

## 4. Build the Windows client release

On the developer PC, run:
```powershell
.\BUILD-CLIENT-RELEASE.bat
```
Wait for all checks and the production build to finish successfully. Distribute the generated compiled release ZIP from the `releases` folder only after a successful build. The source/build-tool ZIP is not itself an installable client release.

## 5. Fresh client PC activation

1. Transfer the compiled release ZIP and customer token securely.
2. Extract the release ZIP.
3. Run `CLIENT-INSTALL.bat`.
4. On first installation, choose a writable database folder (for example `E:\AB`) or press Enter for the default.
5. Save the one-time administrator setup key displayed by the installer.
6. Paste the customer license token when prompted.
7. Start SOLIVY Finance and open the local URL, normally `http://127.0.0.1:3210`.
8. Complete first administrator setup with the one-time setup key and a strong unique password.
9. Sign in, open **License Management**, and press **Refresh**. Confirm that the organization says **Active**, with the expected customer, edition, issue date/expiry, and modules.

The client configuration is stored at:
`%APPDATA%\SOLIVY-FINANCE\client-config.json`

It includes `licenseToken`, `licenseEnforcement`, `dataDir`, `port`, `setupSecret`, and `sessionSecret`. Do not post or send this file unredacted: it contains secrets and the token. The databases live in the selected `dataDir`, separately from the app installation.

## 6. Add a second company to an existing local installation

1. Sign in as administrator and create the organization.
2. Record the actual numeric ID assigned to it.
3. Issue a replacement token that contains **all company IDs that should remain licensed**. For example, if the existing SOLIVY company is ID 1 and the new company is ID 4:
   ```powershell
   node .\scripts\license-tool.cjs issue --private-key "D:\Personal\finance-manager-KEYS\private.pem" --customer "Aarsh Enterprise" --company-ids 1,4 --days 365 --edition professional --features "core,dashboard,accounts,account-movements,parties,purchase,payments,money-in,interest,funding,import,ledger,receivables,reports,bank,backup,gst,commercial-bills,document-settings,settings" --out ".\Aarsh-Combined-License.txt"
   ```
   Replace `1,4` with the actual IDs. The token's customer field is informational; company ID assignment and signature are what the application validates.
4. Stop SOLIVY Finance.
5. Back up `client-config.json`, then replace only its `licenseToken` value with the new token. Do not replace `dataDir`, `sessionSecret`, or database files.
6. Restart SOLIVY Finance and sign in again. Open License Management and refresh.

This build's `CLIENT-START.ps1` clears an inherited `SOLIVY_LICENSES_JSON` environment variable so that a machine/user-level online license map cannot override the saved local token. If a license still says “Not assigned,” verify the token's actual `companyIds` against the selected organization ID and confirm the running app was restarted.

## 7. Renew or replace a local license

1. Confirm the actual company ID and desired modules/duration.
2. Issue a new token using the owner private key.
3. Stop the client server.
4. Back up `client-config.json`; replace only `licenseToken`.
5. Start the client and check License Management.
6. Keep the old token file securely for your records, but do not send it if it is no longer intended to be used.

If the status is:
- **Invalid token format:** the configured value is not the expected two-part token.
- **Invalid signature:** the private key does not match the embedded public key, or the token was altered.
- **Not assigned:** the token does not include the selected company's numeric ID.
- **Expired:** issue a renewed time-limited token.
- **Missing:** the running server did not receive a token; check `client-config.json` and restart the installed launcher.

A `401 Unauthorized` from `/api/license/status` when called directly in PowerShell without a browser session is an authentication result, not proof of an invalid license. Check status from the authenticated License Management screen.

## 8. Online/Vercel licensing

Online licensing is separate from local client activation:
1. Verify that all APIs used by the online deployment are migrated to PostgreSQL and that the online company records exist in the intended schema. A `DATABASE_URL` alone does not migrate SQLite APIs.
2. Read the numeric company IDs from the online PostgreSQL database. Do not reuse local SQLite IDs unless they match.
3. Issue one signed token per company, or a token covering the intended company IDs.
4. In Vercel Project → Settings → Environment Variables, configure `DATABASE_URL`, `SESSION_SECRET`, `SOLIVY_LICENSE_ENFORCEMENT=required`, and `SOLIVY_LICENSES_JSON` for Production. The JSON map uses company IDs as keys and signed tokens as values, for example:
   ```json
   {"4":"SIGNED_TOKEN_FOR_COMPANY_4","5":"SIGNED_TOKEN_FOR_COMPANY_5"}
   ```
5. Redeploy and test company selection, login, License Management, licensed module access, and data persistence.
6. Keep online environment tokens and secrets private.

Important: the supplied v2.5.27 source/build package has previously shown SQLite-on-Vercel and PostgreSQL schema/type errors. Do not consider online licensing production-ready until those database migration and API errors have been fixed and verified. The local Windows activation workflow does not fix online PostgreSQL issues.

## 9. Troubleshooting checklist

- Check the token was saved to `%APPDATA%\SOLIVY-FINANCE\client-config.json` (check only presence/format; do not display the token).
- Confirm `licenseEnforcement` is `required`.
- Confirm `dataDir` points to the intended existing database folder.
- Confirm the token's company ID matches the actual selected organization.
- Confirm the signing key matches the public key embedded in the build.
- Stop and restart the installed app after changing the token.
- Do not use a `SOLIVY_LICENSES_JSON` environment map on a local install; the updated launcher clears it.
- Do not share private keys, license tokens, `client-config.json`, session secrets, or setup secrets publicly.
