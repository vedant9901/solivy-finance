# SOLIVY Finance v2.7.1 — API and Neon transfer optimisation

Build: `SOLIVY-Finance-v2.7.1-API-TRANSFER-OPTIMIZED`. Baseline: v2.7.0-rc.1, which is unchanged and
still available. No financial logic, tax rule, report calculation, document template or UI layout
was changed in this release. All measurements are in `docs/PERFORMANCE-v2.7.1.md`; gate status is in
`RELEASE-STATUS.md`.

## Headline, measured on PostgreSQL 16 (not Neon)

One user session — sign in, open 13 screens, run 3 reports, create 2 records, switch environment
twice — on an application instance with no local copy:

| | v2.7.0-rc.1 | v2.7.1 |
|---|---:|---:|
| Database download | 3,396.6 KB | **299.0 KB** |
| Database upload | 506.1 KB | **73.2 KB** |
| API response bytes | 5,498.5 KB | **2,508.5 KB** |
| API requests | 51 | 47 |

Projected from those figures, a 25 GB monthly allowance covers about 69,000 such sessions, against
about 6,700 before. That is arithmetic from measured per-session transfer, not a measured month.

## Fewer and cheaper requests

- The public sign-in screen reads a small derived projection row instead of downloading the whole
  `admin.db` snapshot: **801 KB → 0.4 KB per visit**, including visits from unauthenticated traffic.
  The projection holds organization id, name and code — nothing else — and the bridge refreshes it
  in the same transaction as every administration write.
- `GET /api/companies` loaded every organization's LIVE and TEST database to list names from
  `admin.db`. It now loads `admin.db` only. This was the largest part of sign-in.
- Group MIS and multi-company report groups load only the organizations actually selected, instead
  of every active organization on every call.
- The dashboard fired `/api/group-mis` three times per mount — twice for the wrong organization —
  because the selection lived in a second state that lagged a render. The selection is now derived,
  so it fires once, after the shell has its identity.
- `/api/data`, `/api/reports`, `/api/companies`, `/api/license/status`, `/api/document-settings` and
  `/api/document-templates` answer **304 Not Modified** when the client already holds the current
  representation. Returning to a loaded screen transfers about 0.4 KB instead of its payload:
  repeat tab switching fell from 1,624 KB to 0 KB of payload, and reopening the Reports hub from
  634 KB to 0 KB.
- A shared browser request layer (`app/lib/client-http.ts`) deduplicates concurrent identical GETs,
  keeps ETag-validated entries per organization and environment, and aborts a request that a newer
  one supersedes (changing a report filter twice now transfers once).
- The Reports tab no longer pre-loads the ledger, purchase and payment tables for the legacy
  MIS & Registers view; it loads them when that view is opened: **634 KB → 8.9 KB**.
- Background synchronisation runs every 10 minutes while the window is in use and every 30 minutes
  while it is hidden, with a catch-up run when it returns. Nothing changes for a configured,
  in-use sync; an idle open tab simply stops polling at full rate.

## Cheaper storage in PostgreSQL / Neon

- Snapshots are chunked at **4 KiB, aligned to the SQLite page size**, so a posting uploads the
  pages it dirtied: creating a party uploads 8 pages (5.9 KB) instead of 406.7 KB.
- Chunks and blobs are compressed with **Brotli** instead of gzip (1.9 MB file: 280 KB → 174 KB).
- Each snapshot keeps a **whole-file base blob**, so an instance with no local copy downloads one
  well-compressed blob plus the chunks that changed after it, instead of hundreds of individually
  compressed chunks. The blob is rebuilt only after 20% of chunks diverge.
- The chunk manifest is stored compressed, removing about 19 KB of protocol text per cold read of a
  3 MB file, and is no longer fetched at all on the write path.
- The **synchronisation journal of a database nothing pulls from** is trimmed to a short retention.
  It was 932 KB of a 1.9 MB organization file — 49% of every hydration. The accounting audit trail
  is never touched, an upstream pairing or an active paired device keeps the full 30-day window, and
  a watermark is recorded so a device paired later re-baselines (410) rather than missing events.
- Bookkeeping DDL no longer invalidates the synchronisation trigger fingerprint, which had caused
  every trigger to be rebuilt on the next open — a 353 KB upload on a read.

## New: administrator transfer diagnostics

**Administration → API & database transfer** reports, per endpoint, per day and per month: request
counts, the share answered 304, request and response bytes, snapshot bytes downloaded and uploaded,
chunk counts, full reloads, and the stored size of every snapshot. `GET
/api/admin/transfer-metrics?days=30` returns the same data.

Figures are labelled as application-measured — the compressed payloads this application moved,
excluding TLS and protocol overhead — and the screen states that the provider's own dashboard
remains the billing figure. Endpoints are recorded as route paths only: no query values, bodies,
user names or financial values are stored.

## Unchanged guarantees

- A cached representation is reused only after the server confirms it with 304. The ETag is derived
  from change watermarks that move on every insert, update and delete of company data, on rows
  applied by a synchronisation pull and on schema changes, plus the caller's organization,
  environment, permissions and requested modules. Tests cover 200-after-write, after an in-place
  edit, after a receipt, after a reversal, after a settings change and after a template save, and a
  write made by another instance.
- LIVE and TEST, and one organization and another, never share a cached entry or a hydrated file.
- Authentication, organization authorisation, audit logs, idempotency, reversal protection, backup
  and restore, and offline operation are unchanged. 93 automated tests pass (67 offline, 22 online
  against real PostgreSQL, 4 browser), plus all 21 legacy regression scripts.

## Upgrading from v2.7.0-rc.1 or v2.6.30

Deploy and start; the first request per organization and environment converts that snapshot to the
new chunk format, trims the journal and rebuilds the base blob. Budget that one-time pass at about
3.4 MB down and 1.3 MB up per file, measured on a 1.9 MB organization. A pre-migration backup is
written first, as before. Take a Neon branch beforehand; rolling back to v2.7.0 means restoring it,
because v2.7.0 cannot read 4 KiB chunks or a compressed manifest. Offline installs are unaffected.
