# SOLIVY Finance v2.5.28 — License activation guide

## A. Owner PC: verify the signing key

1. Extract the source/build project and open PowerShell in its root folder (the folder containing `scripts\license-tool.cjs`).
2. Confirm `Test-Path .\scripts\license-tool.cjs` returns `True`.
3. Verify that the public key derived from your owner private key matches the public key embedded in this exact build. Never send `private.pem` to a customer.
4. Run `node .\scripts\license-tool.cjs self-test`. This checks the tool's signing logic; it does not by itself verify that your private key matches the build.

The public key expected by this build is:

```text
MCowBQYDK2VwAyEAInUktjI0jjuAmYTDfkOjKCiVopMVI3Gaa4cmxnwV1PQ=
```

## B. Issue a license for a client company

1. On the client installation, use License Management to identify the exact Organization ID. IDs can differ between local databases and online databases.
2. On the owner PC, run a command like the following from the project root (replace the customer name, company ID, private-key path, and feature list as needed):

```powershell
node .\scripts\license-tool.cjs issue --private-key "D:\Personal\finance-manager-KEYS\private.pem" --customer "Aarsh Enterprise" --company-ids 1 --days 365 --edition professional --features "core,dashboard,accounts,account-movements,parties,purchase,payments,money-in,interest,funding,import,ledger,receivables,reports,bank,backup,gst,commercial-bills,document-settings,settings" --out ".\Aarsh-Client-License.txt"
```

3. Replace `--company-ids 1` with the actual ID. For multiple companies, use comma-separated IDs such as `--company-ids 1,4`. Issue a replacement token listing every company that should remain licensed.
4. Transfer only the generated token securely. Never transfer the private key.

## C. First-time Windows client installation

1. On the owner/developer PC, run `BUILD-CLIENT-RELEASE.bat` and wait for all checks and the production build to finish successfully. Distribute only the generated ZIP in `releases`, not the source ZIP.
2. On the client PC, extract the client release and run `CLIENT-INSTALL.bat`.
3. Select the database folder when prompted. Do not change or move it during license activation.
4. Paste the customer-specific signed license token when prompted. Save the one-time administrator setup key.
5. Start SOLIVY, create the first administrator, and sign in.
6. Open License Management and verify customer, Organization ID, edition, issue date, expiry, and included modules.

## D. Renew or add another company on an existing Windows client

1. Record the new/target company ID in License Management. Do not assume it is `2` or `4`.
2. On the owner PC, issue a replacement token containing all IDs that should remain licensed.
3. Close SOLIVY Finance on the client PC. Back up `%APPDATA%\SOLIVY-FINANCE\client-config.json`.
4. Edit `client-config.json` and replace only the `licenseToken` value with the complete one-line token. Preserve `dataDir`, `sessionSecret`, `setupSecret`, and the rest of the configuration.
5. Start SOLIVY from the installed desktop shortcut. The v2.5.28 launcher clears inherited `SOLIVY_LICENSES_JSON` for local clients so it uses the saved token.
6. Sign in as administrator, open License Management, click Refresh, and confirm the status is Active.

## E. Troubleshooting

- **Not assigned:** the token's `companyIds` does not include the selected organization ID. Reissue with the correct ID(s).
- **Invalid signature:** the signing private key does not match the public key embedded in this build, or the token was altered/truncated.
- **Invalid format:** copy the entire one-line token, including the single dot between its two parts. Do not include quotes or JSON wrappers in the token value.
- **Still showing old status:** close the app and restart from the desktop shortcut so the launcher reloads `client-config.json`, then refresh License Management.
- **401 from `/api/license/status` in a direct PowerShell request:** this endpoint requires an authenticated administrator session; check status from within the signed-in app.

## F. Online Vercel configuration caveat

1. The online license map uses `SOLIVY_LICENSES_JSON`, keyed by the actual company IDs in the online database, and `SOLIVY_LICENSE_ENFORCEMENT=required`.
2. Configure variables in Vercel Production and redeploy. Keep the private key off Vercel.
3. **This v2.5.28 source package does not migrate all SQLite-backed APIs to PostgreSQL.** Adding `DATABASE_URL` alone is not sufficient for a reliable online deployment. Complete and verify the PostgreSQL migration before using it online for real financial data.

## Security

The owner private key is confidential. License tokens are bearer credentials; transfer them securely and replace any token that has been exposed. Rotate setup/session secrets if they were shared. A perpetual offline token cannot be remotely revoked once issued.
