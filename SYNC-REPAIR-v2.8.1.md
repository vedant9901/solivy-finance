# SOLIVY Finance v2.8.1 — P0 synchronization repair

Baseline: v2.8.0 (`SOLIVY-Finance-v2.8.0-SaaS-REDESIGN-SYNC-FIX.zip`), left untouched for rollback.
Scope: Priority 0 of the product roadmap only. P1 (GRN PDF) and P2 (payment obligation) are not
started.

## The four reported errors, traced to code

The sync path was traced end to end: trigger-based change capture (`lib/db.ts ensureSyncSchema`) →
outgoing batch and parent recovery (`app/api/sync/run/route.ts`) → device credential and
organisation checks (`exchange tokenContext`, run preflight) → table eligibility → conflict
detection and apply (`applyEvent` / `applyLocal`) → acknowledgement, journalling and cursor update.

| Reported error | Cause found | Where |
|---|---|---|
| 3. `Table is not eligible for synchronization. · HTTP status: 409` | `tableInfo()` threw one message that named no table, for four different situations. The membership it tested was maintained in **four** separate copies that had drifted apart: the hub had 11 names, the device 9, the resolver 11, the trigger builder 12. `login_attempts` was excluded only by the trigger builder — so a legacy device that had journalled it would have had those rows accepted by the hub. `sync_resolution_log` and `sync_conflict_history`, added to the hub in v2.8.0, were **not** in the device copy — so a device still holding queued events for them was refused with exactly this message. | `exchange/route.ts:101` (old), `run/route.ts:31`, `resolve/route.ts:9`, `db.ts:167` |
| 2. `SOLIVY stopped this batch to avoid overwriting accounting data…` | Literal: the whole downloaded batch ran inside one `d.transaction()`, so **one** unapplicable event rolled back **every** other event in it. | `run/route.ts` pull loop, `exchange/route.ts` POST loop |
| 4. Push does not sync even though the records look `null` on both sides | Two causes compounding. (a) The absent-record branch `base!==null && !current` threw the same conflict for every operation, **including DELETE** — so a deletion whose record was already gone on both sides was reported as a conflict needing review instead of being the no-op it is. (b) Because of the batch abort above, the push then marked *nothing* as pushed (`pending` stayed `pushed=0`) and the pull committed no cursor, so every later attempt re-sent the identical batch and failed on the identical item. Nothing could ever move. | `run/route.ts:132` (old), `exchange/route.ts:186` (old), `run/route.ts` push marking |
| 1. `A record conflict needs review` | The user-facing wrapper for all of the above; the detail carried no table, key or operation for the item that actually blocked the batch, so there was nothing to act on. | `app/sync/page.tsx explainError` |

Answers to the specific questions in the brief:

- **Why a table was classified ineligible, and whether it should be synchronisable.** Every name in
  the set is genuinely per-device: the sync journal itself, the applied-event and id-mapping tables,
  device acks, the resolution log, the conflict history, local users and login attempts, idempotency
  keys, `sqlite_sequence`, `schema_migrations`, and the licensing/admin mirrors. None should be
  synchronised. The defect was not the membership but that it was decided in four places with four
  memberships and one unexplained message, and that an event for one of them was fatal to its batch.
- **Whether client and server allowlists differ.** They did, in both directions (table above). They
  are now one module: `lib/sync-eligibility.ts`, asserted by a test that fails if any route
  re-declares its own set.
- **What `null` meant.** Not a serialisation fault. It is a genuinely absent row, and the code never
  distinguished *why* it was absent. It now does: already deleted (agreement), never received
  (restore), or deliberately deleted here (do not resurrect).
- **Whether both sides being absent should be create, no-op or conflict.** Per operation, never a
  generic conflict — see the rule below.
- **Stale tombstones, delete/recreate, parent/child, FK mappings.** The v2.8.0 guards (posted,
  dependents, stale-delete, id remapping, FK ordering) are unchanged and still enforced; they are now
  reached per item instead of taking the batch down with them.
- **Whether rejected batches advanced cursors or stuck forever.** They stuck forever: the cursor was
  committed in the same transaction as the applies, so it never advanced past a bad item and the same
  batch failed indefinitely. Now the cursor advances, but only because the rejected event is stored
  in full and replayed from storage rather than from the cursor.
- **Whether retrying can duplicate financial entries.** No. Dedup is by `event_id` in
  `sync_applied_events`, resolutions use deterministic ids (`resolutionIdFor`), and the apply is an
  upsert on the primary key. Tested by repeating pushes and retries and comparing every stored
  figure.

## What changed

New modules:

- `lib/sync-eligibility.ts` — the single eligibility rule. Classifies an ineligible table as
  `LOCAL_ONLY` (per-device bookkeeping → acknowledge and discard as obsolete: no business data, so
  nothing is lost) or `NOT_SYNCHRONISED` / `NO_PRIMARY_KEY` / `INVALID_NAME` (→ quarantine, named).
- `lib/sync-absent.ts` — the deterministic absent-record rule:
  | Operation | Record absent here | Outcome |
  |---|---|---|
  | DELETE | yes | **no-op**, marked applied. Both sides already agree. |
  | INSERT | yes | **apply** (normal insert). |
  | UPDATE/INSERT with a base, no deletion recorded here | yes | **restore** the incoming record — this side never received it; there is no newer data to overwrite. |
  | UPDATE/INSERT with a base, a deletion recorded here | yes | **obsolete** — a deliberate deletion is not undone by an edit made elsewhere against the removed version. Kept in the quarantine so it can be pushed back if the deletion was wrong. |
- `lib/sync-quarantine.ts` — `sync_rejects` (local-only, schema 29): the full event, table, key,
  operation, code, reason, correlation id and attempt count. Plus `describeReject`, which returns
  the live local row, the incoming row, the base and the safe resolutions for that reason.
- `app/api/sync/rejects/route.ts` — `GET` lists the set-aside items; `POST {action:'retry'}` replays
  the stored events; `POST {action:'dismiss'}` stops retrying one and records that decision.

Changed:

- `exchange` POST and `run` pull apply **per event**, each in its own transaction. The response
  carries `rejected[]` (table, key, operation, code, reason, correlation id) and
  `accepted_event_ids`; HTTP 409 is now returned only when *nothing* in the batch could be applied.
  The first rejection is still reported in the old single-conflict shape, so the existing resolution
  UI keeps working.
- The push marks only the events the destination accepted, so a rejected item stays `pushed=0` and
  is retried after its resolution while everything else completes.
- A later acceptance, or a successful conflict resolution, closes the quarantine entry it was
  blocking (`clearRejectsFor`).
- One correlation id per run (`x-solivy-sync-correlation`), echoed in every response. Reject logs
  carry table, key, operation, device, code and that id — asserted by a test to contain no amounts,
  narrations or references.
- The Sync screen reports a partially applied run as a success with items to review, and lists each
  one with Retry / Do not retry.

## Sync release gate

Real SQLite (offline suite) and real PostgreSQL 16 (online suite, hub in a separate process over
HTTP). **Not Neon** — no Neon project was available, so Neon's pooler, TLS and latency remain
unverified.

| # | Gate | Result | Test |
|---|---|---|---|
| 1 | New record created offline, then pushed | PASS | `offline desktop writes are pushed to the online hub with identical financial values` |
| 2 | Existing record edited offline, then pushed | PASS | `master-data edit conflict…`, `gate 11+12…` |
| 3 | Record deleted offline, then pushed | PASS | `a record deleted on the desktop…` |
| 4 | Same record changed on two devices | PASS | `financial edit conflict (same purchase changed on both sides) is blocked for manual resolution` |
| 5 | Deleted on one device, edited on another | PASS | `a record deleted on one side and re-entered on the other keeps the surviving version`, `a stale deletion cannot remove a record that was changed or re-entered afterwards` |
| 6 | Record absent on both sides | PASS | `gate 6: a deletion whose record is already absent on both sides is a no-op, not a conflict` (+ the SQLite rule test) |
| 7 | Parent/child pushed in different order | PASS | `gate 7+8: a child without its parent is rejected per item and applies after the parent arrives` |
| 8 | Retry after a 409 resolution | PASS | `gate 7+8…`, `gate 8: a quarantined pull item is replayed from storage by the retry endpoint` |
| 9 | Network interruption and retry | PASS | `gate 9: a failed sync (unreachable hub) loses nothing and the retry completes it` |
| 10 | LIVE/TEST and organisation isolation | PASS | `LIVE device token cannot be used for TEST and wrong-org tokens are refused` |
| 11 | Purchase, payment, receipt, reversal and party records | PASS | `gate 11+12: purchase, payment, receipt and reversal records synchronise without duplication` |
| 12 | Repeated push does not duplicate entries | PASS | `gate 11+12…`, `hub changes are pulled to the desktop; repeating a sync is a no-op (no duplicates)` |
| — | A rejected item does not block unrelated valid items | PASS | `a local-only table queued ahead of valid records is dropped as obsolete and blocks nothing`, `an unknown table is quarantined by name while the rest of the batch applies` |
| — | Cursor advances without losing the rejected change | PASS | `a rejected pull item advances the cursor, is quarantined, and does not re-block the queue` |
| — | One eligibility rule across hub, device, resolver and trigger builder | PASS | `tests/integration/sync-eligibility.test.ts` |
| — | Diagnostics contain no secrets or personal data | PASS | `reject diagnostics carry the identifiers but no row values` |

Totals: 78 offline (real SQLite), 44 online (real PostgreSQL 16), 10 browser, 15 legacy scripts,
typecheck clean. Evidence: `docs/verification/test-run-2026-10-31-v2.8.1.txt`.

## Risks / not verified

1. **Neon itself is not exercised.** The online figures and results are from a local PostgreSQL 16.
2. **No production build or lint.** The npm registry is unreachable here, so Next.js 15.5.27 is
   still not installed; routes run through a `next/server` shim and an esbuild bundle. Unchanged
   from v2.7.0.
3. **Schema 29 runs on first open** per organisation and environment; it only creates `sync_rejects`
   and clears queued events for local-only tables. A pre-migration backup is written as before, but
   this has not been run against a copy of a real production database.
4. **An obsolete `LOCAL_ONLY` event is acknowledged and discarded.** That is deliberate — the
   affected tables hold no business data — but it is a behaviour change from "refuse the batch".
5. **The tombstone test depends on the journal retention window** (30 days paired). If a deletion
   has been pruned, an edit to that key is treated as "never received" and restores the record
   rather than respecting the old deletion. Documented, not a regression: before this change the
   same event produced an unresolvable conflict.
6. Unchanged carried-over risks: GST/TDS pending CA review, `xlsx` advisories on the import path,
   `'unsafe-inline'` in the CSP, license enforcement off by default.
