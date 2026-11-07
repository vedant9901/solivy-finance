# SOLIVY Finance v2.12.3 — inter-company transfer: "Destination organization is missing mapped bank/cash account"

Baseline: v2.12.2. No schema change, no new API route, no new network call, no sync change, no
change to `purchaseCalc` or to any financial calculation.

## 1. What was wrong

Accepting an inter-company transfer failed with

```
{"error": "Destination organization is missing mapped bank/cash account: Aksh Ent."}
POST /api/transfers
```

A transfer carries its parties and bank/cash accounts **by name**, and the destination was required
to hold an account named character-for-character the same. Four things made that fail badly:

1. **It failed at `accept`, not at `create`.** The transfer had already been sent and was sitting
   PENDING. The sender believed it had gone; the receiver could not take it.
2. **The message named nothing but the name.** Not the record, not the field, not one account the
   destination actually has.
3. **There was no way out except renaming master data.** No control existed to say "our account for
   this is the ICICI current account". For an account named after the organization itself — `Aksh
   Ent.` — renaming is exactly what you do not want to do.
4. **The same name-only lookup existed in four places** (the record's own links, the
   `account_transactions` bundle, the `ledger` bundle, the party identity match), each with its own
   message, so a fix in one left the others.

## 2. What it does now

All four go through `lib/transfers/mapping.ts`.

**The receiver chooses.** When a name cannot be matched, `accept` returns **HTTP 409** with
`reason: "MAPPING_REQUIRED"` and, for each unresolved link: the name as the source holds it, the
corroborating detail the source captured, the record(s) that need it, the field it fills, and
**every bank/cash account (or candidate party) this organization actually has**. The receiving
screen renders that as a chooser; picking the matching record and pressing *Accept with these
choices* imports the transfer. Nothing is renamed in either organization.

**Nothing is ever guessed.** A near match — `AKSH ENTERPRISES` for `Aksh Ent.`, found by folding
case, punctuation and the common trading suffixes — is offered as a **suggestion for a person to
confirm**, and is never applied on its own. Posting a payment to the wrong bank account silently is
worse than refusing to post it. A source check holds that line in the code.

**The import is all or nothing.** `accept` preflights every link against the destination before the
transaction opens, so an unresolved link refuses the whole import instead of failing part-way
through it. The transfer stays PENDING and remains acceptable once the choice is made — it is not
spent by the refusal.

**The sender is told at send time.** `create` still creates the transfer — the receiver may prefer
to create the missing account first — but the response now carries `unresolved_links` and names
what the destination cannot yet match, instead of leaving it to be discovered at acceptance.

**Or create it here.** Where the destination simply does not have the account — the common case
when the source's account is named after the sending organization — the chooser offers *Create
"<name>" here instead*, which adds it with the name, bank and type the source recorded and **a zero
opening balance of its own**, then re-checks. Parties are deliberately not created this way: a
vendor master carries GST, PAN and TDS settings that must be entered deliberately under Parties.

**A read-only preflight.** `{action:'preflight',transfer_id}` reports what an incoming transfer
needs and what it could be given, writing nothing, so a transfer can be inspected before it is
accepted.

**The choice is auditable.** What was mapped is recorded in the `INTERCOMPANY_TRANSFER_ACCEPTED`
audit entry and on the acceptance receipt (`appliedMap`), so the posting can be explained later.

### What was deliberately not changed

- **Identity matching is not loosened.** An account still matches on its name exactly (after case
  folding and trimming); a party on its name plus a GST or PAN agreeing. Those are the rules the
  application already used. An explicit choice is what covers the cases they do not — not a looser
  rule applied to every transfer.
- **The ledger bundle still matches parties by name alone**, as it always has. Tightening it to the
  record links' stricter rule would have rejected imports that work today; a test and a source
  check hold the distinction.
- **A map cannot reach outside the destination.** Every id supplied is checked to exist in the
  destination's own tables before it is used, the map is capped at 500 entries, and each value must
  be a positive integer. A source company's account id is meaningless here and is refused.
- **No financial figure is touched.** The amount, the dates, the deductions and the references are
  imported exactly as the source holds them; only which local row the posting points at is chosen.

## 3. Verification

Evidence: `docs/verification/test-run-2026-11-07-v2.12.3.txt`.

| | Result |
|---|---|
| Typecheck | **PASS** — 0 errors |
| Offline suite (SQLite) | **PASS** — 188/188 run, 0 failures, 15 skipped (below) |
| Online suite (real PostgreSQL 16.15, through the bridge) | **PASS** — 58/58 |
| Browser suite (Chromium) | **PASS** — 22/22 |
| Source invariants | **PASS** — 22 scripts; `check-transfers.mjs` now 32 invariants (was 17) |
| An unmatched account is reported as a choice, naming the record, the field and the destination's own accounts | **PASS** — offline and online |
| A near match is suggested, never applied | **PASS** — the import is refused and nothing is posted |
| The choice imports the records against the chosen account | **PASS** — payment and bank posting both follow it |
| Nothing is imported while any link is unresolved | **PASS** — 0 payments, 0 bank postings after a refusal |
| The transfer is still PENDING after a refusal | **PASS** |
| A map to a row this organization does not hold is refused | **PASS** |
| An exact name still accepts with no map, as before | **PASS** |
| The sender is warned at send time | **PASS** — `unresolved_links` and the name in the message |
| Preflight writes nothing, and honours the map whatever case it is given in | **PASS** |
| A third organization can neither inspect nor accept the transfer, and is shown no account list | **PASS** |
| The choice is on the audit entry and the receipt | **PASS** |
| The reported case: a `money_in` whose party exists but whose account does not | **PASS** — `links_required` 2 with exactly one unresolved, the account; the party matched |
| The source's bank name and type are carried, so the account can be recreated here | **PASS** |
| Creating the missing account here, then accepting, imports the receipt into it | **PASS** — and the new account keeps a zero opening balance, not the source's |
| A party is never created automatically | **PASS** — held by a source check |
| 15 offline tests skipped | **NOT RUN** — `tests/integration/grn-*.test.ts` need `SOLIVY_GRN_SAMPLE_PDF` / `SOLIVY_GRN_SAMPLE_PDF_MULTI`; the two sample PDFs are not present in this session. The committed masked OCR-text fixtures still run. Unchanged by this release |
| `next build`, `next lint` | **NOT VERIFIED** — the npm registry is unreachable here, so Next.js 15.5.27 is not installed |
| Neon | **NOT VERIFIED** — the online suite runs on a local PostgreSQL 16.15 |
| Windows | **NOT VERIFIED** — no Windows machine |
| Transfer types other than `payments` and `money_in` | **NOT VERIFIED** — the mapping is type-independent (it reads `TYPES[type].links`), and `purchases`, `account_movements`, `interest_payments`, `sales` and `funding_loans` go through the same resolver, but no test covers them |
| Offline package / receipt round-trip with a map | **NOT VERIFIED** — `import-package` and `confirm-receipt` are unchanged, and the receipt's added `appliedMap` field is not compared by `confirm-receipt`, so verification is unaffected; no test exercises the offline route with a mapped acceptance |

## 4. Changed files

- `lib/transfers/mapping.ts` — **new**: `resolve` (explicit map, then the application's own identity
  match, else null), `preflight`, `needsOf` / `needFromLink`, `accountCandidates` /
  `partyCandidates`, the confirm-only suggestion, and the message a person reads.
- `app/api/transfers/route.ts` — `remap` and the `account_transactions` / `ledger` bundle lookups
  all resolve through that module; `accept` preflights and accepts `account_map` / `party_map`;
  `create` reports `unresolved_links`; a read-only `preflight` action; `sanitiseMaps`;
  `appliedMap` on the audit entry and the receipt.
- `app/page.tsx` — the receiving screen's chooser, the 409 handling, and *Accept with these
  choices*; every link must be chosen before the button enables.
- `tests/integration/transfer-mapping.test.ts` — **new**, 10 tests (there were none for transfers).
- `tests/online/bridge.test.ts` — the same path through the PostgreSQL bridge, 1 test.
- `scripts/check-transfers.mjs` — 15 new invariants, 32 total.
- `package.json`, `CHANGELOG.md`, `WORKLOG.md`, `ARCHITECTURE.md`, `RELEASE-STATUS.md`, this file.

## 5. If you hit this again

On the receiving organization, open Inter-Company Data Transfer, press **Accept** on the incoming
transfer, and the chooser lists what cannot be matched and what you have. Either pick the matching
account there, or press *Create "<name>" here instead* to add the source's account to this
organization with a zero opening balance and accept. The sender needs to do nothing, and nothing is
renamed.

If the message says `links_required: 2` but lists only one unresolved link, the other one — usually
the party — **did** match; only the one listed is blocking.
