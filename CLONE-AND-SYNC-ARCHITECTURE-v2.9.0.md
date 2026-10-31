# SOLIVY Finance v2.9.0 — bidirectional sync and full database clone

Baseline: `SOLIVY-Finance-v2.8.0-SaaS-REDESIGN-SYNC-FIX` plus v2.8.1 (per-item sync repair),
v2.8.2 (API surface guard, packaging fix) and v2.8.3 (party DELETE conflict). All remain available
for rollback. No business schema change in this release.

## 1. What the architecture actually is

Inspected, not assumed:

- **Online storage is not a row-per-row mirror.** The whole organisation SQLite file lives in
  PostgreSQL as 4 KiB page-aligned Brotli chunks plus a base blob, with a compressed manifest,
  per-organisation advisory locks and optimistic versioning (`lib/snapshot-store.ts`,
  `lib/postgres-sqlite-bridge.ts`). A request hydrates the file, works on it, and the changed pages
  go back.
- **Device ⇄ hub synchronisation is event replication** over HTTP: trigger-captured rows in
  `sync_changes`, applied one at a time with per-item quarantine since v2.8.1
  (`/api/sync/exchange`, `/api/sync/run`).

So the system is a **hybrid**, and that is the root of the problem reported. Event replication can
only converge when both sides descend from a common ancestor. Two databases that drifted apart — or
a device re-baselined from a backup, or an organisation created separately on each side — have no
common ancestor, so every event is a conflict against a record the other side knows differently.
Resolving one conflict then exposed the next, which is exactly the behaviour described.

**A clone creates that common ancestor.** After it, the journal and cursor are realigned so
incremental sync is correct from a known point. This release adds the clone and keeps the existing
incremental sync unchanged.

## 2. The clone engine

`lib/clone-engine.ts` (engine), `lib/clone-store.ts` (durable upload/lock/run state in PostgreSQL),
`app/api/sync/clone` (hub side), `app/api/sync/clone/run` (device side, drives both directions).

Both directions follow the same six steps. Nothing is ever applied in place:

1. **Consistent snapshot** — `VACUUM INTO`, never a byte copy of a live WAL database.
2. **Validate the source** — `integrity_check`, `foreign_key_check`, schema version against
   `SCHEMA_VERSION`, core tables present, and the application's own accounting invariants
   (`lib/data-health.ts`: over-allocated purchases, over-received receivables, money-in stored as a
   debit, unclassified cash rows, negative balances). A source that fails is not transferred.
3. **Fingerprint** — per-table row counts and content hashes for every business table, plus 16
   financial aggregates (purchase net payable, payments, allocations, money in/out, interest,
   receivables receivable and received, funding principal, account-transaction debits and credits,
   ledger debits and credits, party count, reversed payments).
4. **Stage** — the hub writes to a staging key (`company:<id>:<MODE>:clone-staging`), never over the
   live snapshot; the device writes to a temporary file next to its database, never over it.
5. **Verify** — the staged copy is read back out of PostgreSQL (or off disk), validated again, and
   its fingerprint must equal the source's exactly. Any difference aborts before activation.
6. **Activate** — the copy being replaced is kept first (PostgreSQL
   `solivy_sqlite_snapshot_backups` for online, `<database>.pre-clone-<timestamp>.db` for offline),
   then the verified bytes are activated. The local swap is a `rename` within the same directory.

### Transfer

Resumable and chunked, 1 MiB per request, driven by the offline installation:

- **Upload** (`begin` → `chunk` → `status` → `commit`). Each chunk is written straight to
  PostgreSQL keyed by `(upload_id, chunk_no)`, so resending one is idempotent and an interruption or
  an application restart resumes from what arrived. The `upload_id` is derived from the snapshot's
  sha256 and the device, so a restarted device resumes the same upload instead of starting a second.
  `commit` refuses while any chunk is missing (`INCOMPLETE_UPLOAD`) and names the missing ones.
- **Download** (`manifest` → `chunk`), each chunk checksum-verified, retried up to three times;
  a chunk that cannot arrive intact aborts the clone with nothing on the device changed.
- Only one clone per organisation and environment at a time, enforced by a row in
  `solivy_clone_locks` that other instances see; an abandoned lock expires after 30 minutes.

### Identity, which is where silent breakage lived

A snapshot carries the *other* side's `sync_meta`. Activating it verbatim would make the receiving
side adopt the sender's device id — and because the pull filter is `origin_device <> me`, the
receiving side's own changes would then be filtered out and would **silently never arrive**. This
was reproduced in the test suite before it was fixed. Both directions now keep the receiving side's
own identity and pairing, and `realignAfterClone` settles the journal: every local change is in the
snapshot, so nothing is pending, the cursor is set to the snapshot's own high-water mark, and open
quarantine items are closed. Business data is untouched by this step; local-only tables are excluded
from fingerprints precisely because they legitimately differ.

## 3. Conflict management (v2.8.1–v2.8.3, carried forward)

Incremental sync already applies events one at a time, so one unapplicable item no longer aborts a
batch. A rejected item is quarantined in `sync_rejects` with its table, record key, operation,
reason, correlation id, the live local record, the incoming record and the base — and the safe
resolutions for that reason. `/api/sync/rejects` lists them and replays them from the stored event,
so an advanced cursor never makes a change unrecoverable; a deletion blocked by financial history
can be resolved by deactivation instead (`PARTY-DELETE-SYNC-v2.8.3.md`). Financial conflicts are
never auto-merged and never resolved by latest-timestamp; POSTED records are corrected by reversal.

## 4. Dashboard

The Sync screen now carries **Database clone & sync health**: upload/download counts for the last
run, records awaiting review, last successful sync, and five actions — preview or run a full push,
preview or run a full pull, validate both databases, and roll back the online copy. A preview
reports record counts, table counts, size and the differences from the other side without changing
anything. Running a clone requires typing `REPLACE ONLINE|OFFLINE <organisation> <LIVE|TEST>`
exactly, and only an administrator of that organisation can run it.

## 5. Recovery instructions

**Rebuild the online copy from a device** (the device is right):
1. Sync screen → *Preview full push*. Check the record and table counts.
2. *Push full clone…* → type `REPLACE ONLINE <organisation> <LIVE|TEST>`.
3. The report must end at stage `verified` with 0 differences. If it stops earlier, nothing was
   replaced; the stage and the failed checks say why.
4. Run *Validate both databases*, then *Sync Now*.

**Rebuild a device from the online copy** (the online copy is right, or the device is new):
1. Pair the device as usual, then Sync screen → *Preview full pull*.
2. *Pull full clone…* → type `REPLACE OFFLINE <organisation> <LIVE|TEST>`.
3. The previous local file is kept as `<database>.pre-clone-<timestamp>.db` next to the database;
   the report names it. To undo manually, stop the application and copy that file back.
4. Run *Validate both databases*, then *Sync Now*.

**Undo a push clone**: *Roll back the online copy* restores the snapshot kept before the last
activation, after validating it. (It restores the most recent kept copy, so roll back before
pushing again.)

**If a clone is interrupted**: run it again. An upload resumes from the chunks that arrived; a
download starts over but changes nothing until it is complete and verified. If a lock is reported,
either another clone is running or one was abandoned less than 30 minutes ago.

## 6. Tests and evidence

`docs/verification/test-run-2026-10-31-v2.9.0.txt` (Node v22.23.4, 2026-10-31):
**90 offline (real SQLite) · 56 online (real PostgreSQL 16) · 10 browser · 17 legacy scripts ·
typecheck 0 errors — 0 failures.**

`tests/online/clone-e2e.test.ts` (device ⇄ hub over real HTTP, hub on real PostgreSQL):

| Mandatory scenario | Result |
|---|---|
| Offline → online full clone | PASS — activated only after the staged copy's fingerprint matched; hub record counts and purchase/payment totals equal the device's |
| Online → offline full clone | PASS — an online-only record arrives, previous file kept, device keeps its own identity, nothing business-related left pending |
| Repeated clone without duplicates | PASS — two further pushes changed no counts |
| Incremental sync both directions after a clone | PASS — device→hub and hub→device, repeats create no duplicates |
| Network interruption mid-transfer | PASS — commit refused with the missing chunks named, then completed |
| Application restart mid-sync | PASS — a fresh `begin` for the same snapshot resumed the same `upload_id` and reported exactly the missing chunks |
| Duplicate retry | PASS — resending a chunk did not add a second copy; repeat commits are safe |
| Partial batch failure | PASS — `INCOMPLETE_UPLOAD`, nothing activated |
| Schema version mismatch | PASS — refused at `validate-upload`, online copy unchanged |
| Rollback after a failed/unwanted activation | PASS — kept snapshot restored and verified |
| Multiple companies and isolation | PASS — a second organisation untouched, no cross-organisation records |
| Two clones at once | PASS — second start refused with `CLONE_IN_PROGRESS` |
| Simultaneous edits, missing parent/child, delete-and-recreate, financial receipt and reversal conflicts | PASS — the 21 pre-existing sync tests (v2.8.1–v2.8.3) still pass unchanged |
| Preview and confirmation | PASS — preview changes nothing; a wrong confirmation phrase is refused with HTTP 428 |

`scripts/check-clone-dashboard.cjs` (in the release gate) additionally asserts the dashboard's five
actions, the typed confirmation, staging-before-activation, the kept rollback copy, the financial
totals in every verification, durable (not in-memory) upload state and locks, and that foreign keys
are never disabled anywhere in the clone path.

## 7. Limitations, honestly

1. **Neon itself is still not exercised.** Every online result here is from a local PostgreSQL 16.
   Neon's pooler, TLS and transfer meter are untested.
2. **No production build or lint** — the npm registry is unreachable in this environment, so
   Next.js 15.5.27 is not installed; routes run through a `next/server` shim and an esbuild bundle.
3. **A clone replaces the destination wholesale.** It is the right tool for re-baselining and
   recovery, not for merging two databases that both contain records the other needs. For that,
   clone in the direction that would lose least, then re-enter the few records from the kept copy —
   the replaced copy is retained for exactly this.
4. **The online rollback keeps one generation** per organisation and environment (the most recent
   pre-clone snapshot). Earlier generations are in `solivy_sqlite_snapshot_backups` and can be
   restored with `scripts/online-snapshot-tool.ts`, not from the dashboard.
5. **Clone size** was tested on test-sized databases (tens of KB to a few MB). Chunking is 1 MiB per
   request with 10 MB request limits, so larger databases are expected to work and to resume, but
   multi-hundred-megabyte clones have not been measured here, and a serverless request timeout could
   interrupt a very large `commit` (which then resumes).
6. **`audit_logs` is compared as append-only**: a copy must not hold *fewer* rows than its source,
   and in a live two-sided comparison an unsynced log row is reported as pending rather than as a
   difference. Every other table is compared by exact row count and content hash.
7. **Clone operations are not yet exposed to multi-company batch use**: one organisation and
   environment per run, deliberately.
8. The device-side clone orchestrator requires an administrator session on the offline installation
   and a valid pairing token; it is refused on an installation that has no online database
   configured, and the hub endpoint is refused where PostgreSQL is absent.
