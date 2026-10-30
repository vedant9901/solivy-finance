# SOLIVY Finance v2.7.2 — Operations guide

Install, offline/online setup, migration, backup and restore, rollback, and troubleshooting. The environment variables are listed in `.env.example`.

## 1. Install
- You need **Node.js 20.11–22.x** (`engines` in package.json).
- better-sqlite3 needs either a prebuilt binary for your Node version or a C++ toolchain.

```bash
npm install                 # first time with registry access; then commit package-lock.json
npm ci                      # every later install / CI
cp .env.example .env.local  # fill SESSION_SECRET, SOLIVY_SETUP_SECRET (and DATABASE_URL for online)
npm run build && npm start  # production
```
After the first start, open the app's first-run setup screen, enter `SOLIVY_SETUP_SECRET` and create the administrator. Then remove the secret.

## 2. Offline mode (local SQLite)
- Leave `DATABASE_URL` empty. Data lives in `FINANCE_DATA_DIR`:
  - `admin.db` (users, organizations, sessions, audit);
  - one `.db` file per organization per environment (LIVE/TEST).
- Pending offline changes are kept in the sync journal inside each file, so they survive a restart.
- Pair the offline install with the online server in **Settings → Sync**:
  - device tokens are scoped to one organization and one environment;
  - financial-table conflicts **stop for manual resolution** and are never merged automatically.

## 3. Online mode (PostgreSQL / Neon)
1. Set `DATABASE_URL`. For Neon, use the **pooled** string with `sslmode=require`. TLS is verified.
   - `SOLIVY_PG_SSL=disable` is honoured only for loopback hosts.
2. The first request creates these tables:
   - `solivy_sqlite_snapshots` (version, sha256, compressed manifest, chunk size, base blob);
   - `solivy_sqlite_chunks`;
   - `solivy_sqlite_snapshot_backups`;
   - `solivy_login_attempts`;
   - `solivy_public_projections` (the sign-in screen's organization list, derived from admin.db);
   - `solivy_transfer_metrics` (the administrator transfer diagnostics);
   - `solivy_transfer_alerts` (monthly budget thresholds already raised).
3. Each request downloads only the database files it needs, and only the changed 4 KiB chunks (one
   SQLite page each, Brotli-compressed). An instance with no local copy takes a whole-file base
   blob plus the chunks that changed after it.
   - Writes are a single transaction under a per-organization advisory lock with optimistic versioning.
   - A conflicting write returns HTTP 409, and the client retries.
4. To move existing offline files online, upload them with the snapshot tool (section 5). The old `npm run db:upload-sqlite-snapshots` now refuses v2.7 tables.

## 3a. Watching transfer (v2.7.1)
**Administration → API & database transfer** (administrators only; `GET /api/admin/transfer-metrics?days=30`)
reports requests per endpoint, the share answered 304, request/response bytes, snapshot bytes up and
down, and the stored size of every snapshot, by day and by month.

Set `SOLIVY_TRANSFER_BUDGET_GB` to your provider's monthly allowance (default 25). The panel shows
month-to-date usage against it, a month-end projection, and alerts when 50%, 75%, 90% or 100% is
reached — each raised once per month. It also flags endpoints whose transfer today is far above
their own recent median, and shows every endpoint's declared access class (READ / WRITE / NO_DB)
with its database reads and writes.

If the panel ever reports "read-only guard blocked N snapshot upload(s)", a read-only endpoint
tried to modify a database. The change was not uploaded and nothing is lost, but it is a defect:
note the endpoint it names and report it.

These are **application-measured** figures — the compressed payloads this application moved,
without TLS or protocol overhead — so they are a lower bound. Your provider's own meter (Neon →
"Data transfer") remains the billing figure. Compare the two before drawing conclusions about an
allowance.

## 4. Migrations (schema v27)
- The schema version is controlled by `PRAGMA user_version` (`SCHEMA_VERSION` in `lib/db.ts`). Each run is recorded in `schema_migrations`.
- Before migrating a file, the app keeps a copy:
  - offline: `VACUUM INTO pre-migration-backups/<name>-v<old>-to-v27-<timestamp>.db` in the data folder (if that copy cannot be written, the upgrade stops);
  - online: a row in `solivy_sqlite_snapshot_backups`.
- Migrations are additive (new tables, columns and indexes). No financial record is renumbered or recalculated.
- The previous automatic repairs are now explicit admin actions in **Admin → Data health**:
  - legacy TDS settlement, money-in direction, bill renumbering and party mirroring;
  - GET shows a dry run; POST requires `confirm:true`.

## 5. Backup and restore
**Offline.** **Settings → Backup** downloads a SQLite file per organization (`GET /api/backup`).
To restore:
1. Stop the app.
2. Move the current `.db` (and its `-wal`/`-shm` files) aside.
3. Copy the backup file into place.
4. Start the app.
5. Check the trial balance.

**Online** (use the commands below; stop traffic or accept 409 retries):
```bash
export DATABASE_URL=...           # the target database
npm run snapshot:online -- list
npm run snapshot:online -- export company:2:LIVE ./company2-live.db
npm run snapshot:online -- import company:2:LIVE ./company2-live.db            # dry run: integrity + size
npm run snapshot:online -- import company:2:LIVE ./company2-live.db --confirm  # current version is backed up first
npm run snapshot:online -- backups company:2:LIVE
npm run snapshot:online -- restore-backup <id> --confirm                       # roll back to a saved version
```
Database keys are `admin`, `company:<id>:LIVE` and `company:<id>:TEST`.

Always take a Neon branch or snapshot before an import.

## 6. Rolling back to v2.6.30
Upgrading to v2.7.1 converts each snapshot on its first request: the chunk size changes to 4 KiB,
compression changes to Brotli, the base blob is rebuilt and the synchronisation journal of a
database nothing pulls from is trimmed. Measured on a 1.9 MB organization file, that one-time pass
moves about 3.4 MB down and 1.3 MB up. **Take a Neon branch or snapshot before deploying**: v2.7.0
and earlier cannot read the new format.

The journal trim applies only where there is no upstream pairing and no active paired device. It
never touches `audit_logs`. It records a prune watermark, so a device paired afterwards is told to
re-baseline (410 `SYNC_HISTORY_PRUNED`) instead of silently missing events.

- **Online:** a v2.6.30 or v2.7.0 build cannot read the v2.7.1 chunked format.
  1. Restore the Neon branch you took before the upgrade, or
  2. for each key, `export` it, then write the exported file to `solivy_sqlite_snapshots.db_file` with v2.6.30's uploader against a database **without** the v2.7 columns.
- **Offline:** stop the app and replace each `.db` with its copy from `pre-migration-backups/`.
  - Data entered after the upgrade is lost unless you export it first.
  - v2.6.30 ignores the extra v27 tables, but **renumbering-on-open resumes** in v2.6.30.

## 7. Production settings checklist
- `NODE_ENV=production`, plus strong `SESSION_SECRET` and `SOLIVY_SETUP_SECRET` values.
- `SOLIVY_LICENSE_ENFORCEMENT=required`, with tokens set.
- Behind a reverse proxy: `TRUST_PROXY_HEADERS=1`, and only if the proxy overwrites `X-Forwarded-For`.
- HTTPS only. The session cookie is `HttpOnly` and `SameSite=Strict`, and it is `Secure` when the request is HTTPS (directly or via `x-forwarded-proto`).
- A Neon branch or snapshot schedule, plus regular `snapshot:online export` copies kept off-site.

## 8. Troubleshooting

| Symptom | Cause / action |
|---|---|
| `SESSION_SECRET must be configured in production` | Set `SESSION_SECRET`. |
| HTTP 409 "Another request changed … Nothing from this request was saved" | Two writes hit the same organization at once. Admin-data conflicts are retried on the server; for organization data, the user retries the action. If it keeps happening, look for a stuck instance or a running import. |
| HTTP 410 `SYNC_HISTORY_PRUNED` | The device's cursor is older than the pruned journal (30-day retention; a device inactive for more than 90 days no longer holds back pruning). Re-baseline the device by restoring a current backup, then pair it again. Events are never skipped silently. |
| Sync stops with "A record conflict needs review" | The same financial record was changed on both sides. Review it on the **Sync** page and choose push local, accept remote or defer. Financial tables are never merged automatically. |
| User is signed out with `SESSION_REVOKED` | Their password, role or active flag changed, or an admin revoked their sessions. This is expected. |
| HTTP 429 at login | The throttle is keyed on client IP + username: 5 failures block for 2 min, 10 for 15 min, 20 for 60 min. Wait for the `Retry-After` period; a successful login clears the counter. |
| `Integrity check failed` from the snapshot tool | The file is corrupt or not a SOLIVY database. Nothing was written. |
| A screen looks out of date | Screens revalidate with the server on every visit and only reuse data the server confirms with 304, so this is not a cache. Reload; if it persists, check the diagnostics panel for failed requests. |
| Diagnostics show zero in offline mode | Offline installs keep the counters in memory only, so they reset when the process restarts. |
| Transfer much higher than the diagnostics suggest | Expected right after an upgrade (one-time snapshot conversion), and the diagnostics exclude TLS and protocol overhead. Compare a quiet day. |
| License "not configured" | Enforcement is `required`, but there is no `SOLIVY_LICENSE_TOKEN` or `SOLIVY_LICENSES_JSON` entry for the organization. Admins can still reach core settings and backup to recover. |
| `FINANCE_DATA_DIR is not configured` (check:env) | Set `FINANCE_DATA_DIR`, or run the local installer. |

## 9. Tests
```bash
npm test                                                     # unit + integration (SQLite)
SOLIVY_TEST_PG_URL=postgres://user@host:5432/db npm run test:online   # needs a disposable Postgres/Neon branch — tables are created/dropped
npm run test:ui                                              # needs Playwright Chromium
npm run check:legacy                                         # v2.6.x regression scripts + the API access audit
npm run check:api-access                                     # every route declares READ / WRITE / NO_DB and the code agrees
npm run bench:online                                         # server-side transfer benchmark (needs SOLIVY_TEST_PG_URL)
npm run bench:client                                         # real UI in Chromium: requests, response bytes, PG bytes per workflow step
npm run bench:write                                          # chunk-level cost of one posting (needs SOLIVY_TEST_PG_URL)
npm run bench:response                                        # what the API payloads cost compressed
npm run snapshot:online -- list                              # snapshot inventory (needs DATABASE_URL)
```
**Never point `SOLIVY_TEST_PG_URL` at a production database.**
