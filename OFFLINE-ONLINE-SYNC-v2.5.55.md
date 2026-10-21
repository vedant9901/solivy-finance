# SOLIVY Finance v2.5.55 — Offline/Online Sync Foundation

## Included
- Local SQLite change journal with triggers for supported business tables.
- Admin-only online device pairing (`POST /api/sync/pair`) that returns a one-time scoped device token.
- Device-token-authenticated exchange (`GET/POST /api/sync/exchange`) scoped to company ID and LIVE/TEST environment.
- Manual sync endpoint (`POST /api/sync/run`) and `/sync` page with optional automatic retries while the page remains open and internet is available.
- Batch idempotency, optimistic conflict detection, a maximum batch size of 500, and a local ID range reservation intended to reduce collisions for new offline-created AUTOINCREMENT rows.
- LIVE and TEST cannot be crossed by the sync runner; pair each environment separately.

## Deployment
1. Back up all offline and online databases.
2. Deploy this source to Vercel or your own Node.js host.
3. Configure `DATABASE_URL` for persistent PostgreSQL and `SESSION_SECRET` in the host's environment settings. Never commit secrets.
4. Run `npm install`, then `npm run check:sync`, `npm run check:database-bridge`, `npm run check:security`, `npm run check:source`, and `npm run build`.
5. Log in to the online installation as an organization ADMIN, select the destination company and environment, then call `POST /api/sync/pair` with JSON `{ "device_name": "Offline office PC" }`. The response returns a device token once. Keep it private.
6. On the offline installation, open `/sync`, enter the online base URL, the online destination company ID from pairing, and the token. The environment must match the selected local environment. Click Sync Now; enable automatic sync to retry when online and every five minutes while the page remains open.
7. Run first against TEST data. Compare source/destination record counts, bank balances, purchase totals, outstanding balances and ledger postings before using LIVE.

## Important limitations and safety
- This is an incremental sync foundation, not a substitute for a full accounting migration. It synchronizes changes made after these triggers are installed; it does not automatically seed all existing historical records. Perform a separately verified initial migration/baseline before first sync.
- Offline and online company databases must already represent the same company, have compatible schemas, and share compatible existing IDs. Independent new inserts use reserved AUTOINCREMENT ranges when `/api/sync/run` is first run, but legacy IDs and manually supplied IDs can still conflict.
- A conflict returns HTTP 409 and the affected batch is not committed. Review and reconcile the conflict; do not force overwrite.
- Automatic sync runs only while the `/sync` page is open in a running application. Closed-browser background sync requires a separate desktop service/agent and is not included.
- Device token is stored in the browser localStorage on the offline installation. Restrict the Windows account and revoke the device token if the device is lost. Add an admin revocation workflow before broad client rollout.
- File attachments and data stored outside the tracked SQLite tables are not synchronized by this first foundation.
- A successful source check does not prove a full production build or live SQLite/PostgreSQL integration. Test two disposable databases and simulate interrupted requests, duplicate retries, FK dependencies and conflict cases before using LIVE.

## Endpoint behavior
- `POST /api/sync/pair` — online admin session; body may include `device_name`.
- `POST /api/sync/exchange` — device token; accepts `{ "events": [...] }`.
- `GET /api/sync/exchange?cursor=N&limit=200` — retrieves remote changes.
- `POST /api/sync/run` — local authenticated session; body `{ "remote_url": "https://host", "remote_company_id": 3, "device_token": "..." }`.
