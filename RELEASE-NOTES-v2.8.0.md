# SOLIVY Finance v2.8.0 — SaaS redesign + sync fix

Build: `SOLIVY-Finance-v2.8.0-SaaS-REDESIGN-SYNC-FIX`.

**Baseline note:** this repository's latest build was **v2.7.3** (tags v2.7.0-rc.1 … v2.7.3); there
is no v2.7.5 here. v2.8.0 is built on v2.7.3, which is tagged and unchanged as the rollback point.
If a v2.7.5 exists elsewhere, its changes are **not** in this build.

## Priority 1 — critical fixes

### A. Sync conflicts involving deleted, missing or recreated records

`This conflict involves a missing/deleted record. Use a dedicated delete/recreate resolution` was a
dead end: the resolution it told you to use did not exist, so the queue stayed blocked. Four defects
were found and fixed.

1. **No delete resolution existed.** Both choices now work when a side has no record:
   keeping this device's deletion pushes the deletion to the other side; accepting the other side's
   deletion applies it here. When both sides already deleted the record, the conflict just clears.
2. **A deletion could silently remove newer financial data.** A `DELETE` event was applied whenever
   the row existed. It is now refused when the record no longer matches what the deleting side saw
   — the recreate case — and raises a conflict instead, with an explicit override if you really
   mean it.
3. **Dependent and posted records were not considered.** A deletion stops while payment
   allocations, ledger entries or receivables still point at the record, and lists them; confirming
   removes them together, and the parent plus every removed child is written to
   `sync_resolution_log` first, so the audit trail and a recovery copy survive. A **POSTED**
   financial record is never deleted by a resolution — it must be reversed, as the accounting rules
   require.
4. **Resolved conflicts came back.** A resolution was journalled as originating from the device that
   applied it, so it echoed to the peer and conflicted again — the queue could never be drained.
   Resolutions are now attributed to the device that resolved them, a "keep my version" decision
   records the incoming event as handled, and resolution ids are derived from the conflict, so
   retrying applies it exactly once and never duplicates a payment, receipt, purchase or ledger
   entry.

Also: the conflict-resolution log and conflict history are no longer synchronised (they are local
audit artefacts; one before-image could make a sync payload too large to accept).

### B. Purchase register Net Payable mismatch

The register shows the stored `net_payable`; the purchase form recomputed it live with **today's**
company discount base. A record saved while "discount after quality" was off, opened after it was
switched on, therefore showed two figures differing by exactly **quality × discount%** — ₹1,042 on
the reported bill. Historic documents are never recalculated, so the rule a record was *saved* with
is now what displays it:

- `purchases.discount_after_quality` records the rule in force at save time (new nullable column);
- an older record resolves the rule that **reproduces its stored total**, so the form matches the
  register exactly;
- a record no rule reproduces is flagged in the register ("check: form shows …") with the stored
  figure still displayed, because that is what the ledger posted. Nothing is recalculated or
  rewritten silently.

Search, sorting and exports continue to use the stored figure, so they all agree.

## Priority 2 — SaaS redesign

- **Themes:** Light, Dark and System, plus seven accents (teal, blue, violet, emerald, amber, rose,
  slate). Everything is token-driven in `app/theme.css`, so every screen follows. Choices persist
  per device and apply before the app renders.
- **Sidebar restructured** into **Core Finance**, **Collection & Funding**, **Purchases**,
  **Reconciliation & Reports**, plus Administration & Sync. **Vendor Ledger, Tally Export, GST
  Filing and Secondary Backup are no longer listed** — their screens, APIs and data are untouched
  and still served (a test asserts this).
- **Profile & settings module:** identity and user ID, organisation and environment, the modules the
  account may use, session and security facts, appearance, and a password change with client-side
  checks.
- **Dashboard and lists:** loading skeletons while data arrives, animated figures that count to
  their new value (respecting reduced-motion), quieter surfaces, tabular numerals for money.
- **Mobile:** grouped navigation drawer, 44–48px touch targets, 16px-class inputs (no iOS zoom),
  readable tables, no horizontal overflow (asserted at 390×844 on the dashboard and the purchase
  screen).

## Priority 3 — safeguards

Schema change is additive and nullable (`purchases.discount_after_quality`, schema version 28); no
stored amount is modified. APIs, LIVE/TEST isolation, permissions, audit trails, offline SQLite and
Neon online operation are unchanged. `/api/data` keeps its exact v2.6.30 shape in legacy mode; the
three derived register fields are added only for module-based callers, so the v2.7.2 transfer work
is not regressed (the conditional-response and access-class tests still pass).

## Tests

118 automated tests pass: **72 offline**, **36 online** against real PostgreSQL 16 (not Neon),
**10 browser**, plus 22 legacy regression scripts and the API access audit. New: 5 sync
delete/recreate tests, 4 register-parity tests, 6 interface tests with screenshots in `docs/ui/`.

## Known limitations

1. **Neon was not used** — online tests and any transfer figures come from a local PostgreSQL 16.
2. **No production build.** The npm registry is unreachable here, so there is still no lockfile and
   `next build`/`next lint` have never run. The browser tests bundle the real components with
   esbuild and load the hand-written CSS, but **Tailwind utility classes are not compiled in that
   harness**, so the redesign is verified for structure, theming, behaviour and mobile layout
   metrics — not for final compiled appearance. Review it visually after a real build.
3. The register flag identifies records whose stored total no inputs reproduce; **correcting** them
   is not automated — open and save the record, or use an audited repair.
4. Sync resolution of a *parent* record cascades only to rows linked by a declared foreign key.
5. `UserProfile` (the previous profile screen) is still in the source but no longer mounted.
