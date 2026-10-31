# SOLIVY Finance v2.8.3 — party DELETE sync conflict (P0)

Baseline: `SOLIVY-Finance-v2.8.0-SaaS-REDESIGN-SYNC-FIX` plus v2.8.1 (sync repair) and v2.8.2 (API
compatibility). All three remain available for rollback.

Reported: `parties · DELETE · id 15` →
`FOREIGN_KEY: Referenced tables not discoverable from this table schema.`

## Root cause — two defects, both confirmed in code

**1. The device-side apply deleted the row with no dependency guard at all.** The hub
(`/api/sync/exchange`) checked the posted guard, the stale-delete guard and dependents before
deleting. The device-side apply — `applyLocal`, now `lib/sync-apply.ts` — did only this:

```ts
if (e.operation === 'DELETE') { if (current) d.prepare(`DELETE FROM "${table}" …`).run(…); }
```

So a deletion pulled onto a device that still held the party's purchases, payments and ledger rows
went straight to SQLite and came back as a bare `FOREIGN KEY constraint failed`.

**2. The message was built in the wrong direction.** `describeForeignKeyFailure` named the parents
from `PRAGMA foreign_key_list("parties")` — the tables **parties points at**. `parties` points at
nothing, so the list was empty and the text fell through to "not discoverable from this table
schema". What blocks a DELETE is the opposite direction: the tables that point **at** parties.

### The actual dependencies of a party (resolved at runtime, not guessed)

`PRAGMA foreign_key_list` over every table in the organisation database gives **12 declared foreign
key columns in 11 tables**:

| Table | Column |
|---|---|
| purchases | party_id |
| payments | party_id |
| ledger | party_id |
| money_in | party_id |
| money_out | party_id |
| financing_receivables | party_id |
| interest_payments | party_id |
| funding_loans | lender_party_id |
| saudas | purchase_party_id, selling_party_id |
| bank_accounts | party_id |
| party_aliases | party_id |

Columns such as `purchases.broker_party_id` reference a party **by convention with no foreign key**:
SQLite does not block a deletion for them, so the row would be left pointing at a party that no
longer exists. Those are now found and reported separately, flagged
`[no foreign key: would be left dangling]`.

## What changed

- **`lib/sync-fk.ts` (new)** — one place that resolves both directions from the live schema:
  `referencesTo(db, parent, key)` returns every referencing table, column, row count **and up to
  five blocking record ids**, matching the parent table name case-insensitively, including a
  table's second reference column, and including undeclared conventional references.
  `describeForeignKeyFailure` is now operation-aware: a DELETE lists the blockers and their ids, an
  INSERT/UPDATE still lists the parents it depends on. Both sync routes import it; the two
  divergent copies are gone.
- **A probe failure can no longer read as "no dependents."** `dependentsOf` previously wrapped its
  count query in `catch { }` and returned nothing on error, which let a blocked deletion through to
  the database. A table whose count cannot be read is now reported as blocking with an unknown
  count.
- **`lib/sync-apply.ts`** — the device-side DELETE now runs the same guard chain as the hub: the
  posted guard, the stale-delete guard for financial tables, then the reference check. A blocked
  deletion raises `HAS_DEPENDENTS` naming every blocking table, column and record id, deletes
  nothing, and stays retryable.
- **Deactivation instead of deletion** — `POST /api/sync/rejects {action:'deactivate'}` sets the
  record's `active` flag to 0 for a table where that is the safe outcome (`parties`,
  `third_parties`, `company_accounts`, `godowns`, `companies`), as an ordinary journalled UPDATE so
  the other device receives the same state, records it in `sync_resolution_log` under a
  deterministic resolution id, and closes the queued deletion. **Every referencing record is kept.**
  It is only ever done on explicit request, and the Sync screen offers it as "Deactivate instead"
  on a blocked deletion. A financial table has no such column and the request is refused with the
  reason.
- Conflict diagnostics on the Sync screen now show the blocking tables with their record ids and
  the safe options for that reason.

Not done, deliberately: foreign keys are never disabled, financial history is never cascade-deleted,
and a queued deletion is never discarded automatically.

## Tests and evidence

`docs/verification/test-run-2026-10-31-v2.8.3.txt` (Node v22.23.4, 2026-10-31):
**90 offline (real SQLite) · 46 online (real PostgreSQL 16) · 10 browser · 16 legacy scripts ·
typecheck 0 errors — 0 failures.**

Real SQLite — `tests/integration/party-delete-refs.test.ts`:
every referencing table and record id is found in the right direction (purchases 101/102, payments
201, money_in, ledger, both `saudas` party columns), another party's rows are not reported, an
undeclared `broker_party_id` reference is reported as dangling, the DELETE diagnostic no longer says
"not discoverable" and names `1 purchases via party_id (101)`, an INSERT still reports its parents, a
failed probe is reported as blocking with an unknown count, and a party is deactivatable while
`purchases` and `ledger` are not.

Real PostgreSQL (device ⇄ hub over HTTP) — `tests/online/sync-e2e.test.ts`:
- a party deletion pulled onto a device holding a purchase, a payment and ledger rows is refused
  with `HAS_DEPENDENTS`, names purchases, payments and ledger with their ids, offers `active` as the
  safe column, deletes nothing, and is listed in the quarantine with a "Deactivate instead" option;
- deactivating it preserves the purchase and the payment, sets the party inactive, resolves the
  queued deletion, is idempotent when repeated, and the **hub receives `active=0`** on the next sync;
- with a non-financial dependent (a party alias), the queued deletion stays blocked and retryable,
  then applies once the alias is removed through the application; replaying it recreates nothing and
  the queue drains;
- the pre-existing 19 sync tests (per-item rejection, posted guard, stale deletion, cascade
  confirmation, LIVE/TEST and organisation isolation, no duplicates on repeated push) still pass.

A POSTED purchase is still never deletable by a sync resolution — proven incidentally while writing
these tests, when a raw deletion of a posted purchase was correctly refused with "corrected by
reversal, not deleted".

## Risks / not verified

1. **Party id 15 in your database was not inspected** — I have no access to it. The dependency list
   above is resolved at runtime from the schema, so the conflict will now name the exact tables and
   record ids for that party. Run the sync again and the message will state them.
2. **No production build or lint** (npm registry unreachable here); **Neon not exercised** (local
   PostgreSQL 16).
3. Deactivation sets `active=0`. Screens that list parties without filtering on `active` will still
   show the record; that is existing behaviour and was not changed in this release.
4. Undeclared references (`broker_party_id` and similar) are reported but do not block a deletion,
   because the schema does not. Adding foreign keys for them would be a migration and is not done
   here.
5. The five-id cap per blocking table is a display limit; the count is exact.
