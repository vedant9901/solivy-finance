# SOLIVY Finance v2.12.0 — a consignment list is many GRNs, and a document is many pages

Baseline: v2.11.2. No schema change, no new API route, no new network call, no sync change.

Acceptance fixture: the supplied **S M CORPORATION** scan — 13 pages, no text layer, one JPEG per
page. Page 1 is a Sayaji consignment list of **twelve** rows; pages 2–13 are eleven supplier bills
from three suppliers and a handwritten slip.

## 1. What was wrong

The pipeline read **one** GRN and **one** supplier bill from an upload. On this document that meant
one purchase out of twelve, and one bill out of eleven. Everything else was discarded silently.

## 2. What it does now

**Every data row of the list is its own GRN.** `lib/grn/multi.ts` finds the table, takes every row
up to but not including the Total row, and gives each one a stable identity from its page and
printed position (`p1r1` … `p1r12`) — never an array index. All eleven columns are read per row:
sample number, GRN date, truck/RR number, PO supplier name, received bags, net received weight,
freight, load/unload, rokdi, moisture % and the deduction. Each row carries its own draft purchase,
built by the **existing** `buildDraft` and priced by the **existing** `purchaseCalc` — no
calculation is duplicated and none is invented.

**Every page is classified and kept.** GRN list, tax invoice, bill of supply, handwritten slip, or
not recognised — the last two are shown rather than dropped. Classification is fuzzy on purpose:
these scans render "Bill of Supply" variously as `Billof suenly` and `—Bilhof Supply`.

**Goods lines are read from the column order the bill itself prints.** Two layouts appear here and
they disagree — a tax invoice heads its columns `NO.of UOM NET rate per Amount CGST SGST IGST`, a
Tally bill of supply `HSN/SAC Quantity Rate per Amount` — so the order is taken from the page
instead of either being hardcoded. Line number, product, HSN, packages, quantity, unit, **rate**,
per, amount and round-off are separate fields.

**The rate is never derived.** Where the bill prints no rate, or a broker's handwriting has taken
the cell, the rate stays empty and `calculated_check` carries amount ÷ quantity, labelled as a
check. On page 12 that is 9,87,305 ÷ 340.45 = 2,900 — reported, never promoted to the rate. Where a
rate *is* printed, quantity × rate is checked against the amount and a disagreement is reported
without changing anything (page 4 reads a rate of 750 against an amount that implies 2,750; it is
flagged, not corrected).

**The printed Total is a cross-check, never a correction.** The rows are summed and compared
column by column. On this document the rows add to 7,531 bags against a printed 7,601, and
3,57,399 kg against 3,87,399 — both reported, with the rows left exactly as read. That check is
what surfaces a misread cell.

**Links need corroboration.** A bill is attached to a row on the vehicle number (the list prints
its tail, the bill the whole of it), the bag count, the supplier's name and the dates being close —
with the evidence listed. Page 2 links to row 1 on `…0139` plus 590 bags plus the name: high
confidence. Where two rows fit a bill equally well the tie is reported for confirmation rather than resolved
silently. A bill with nothing in common is left unlinked.

**Nothing is placed where it does not belong.** A row with more figures than columns keeps the four
read from the front and leaves the rokdi, moisture and deduction **empty** with every figure
listed, because putting a wrong number in a financial field is worse than an empty one. The same
rule governs goods lines; a trailing blank tax cell is the one allowed exception, since it shifts
nothing before it.

**One GRN at a time.** The wizard lists all twelve consignments with their columns, their matched
bill and their warnings. Choosing one loads that row's own draft; Add Purchase → Save remains the
only write path, and a list is never combined into one purchase. All 13 pages are listed with what
each was taken to be and the rate read from it.

## 3. Verification

Evidence: `docs/verification/test-run-2026-11-02-v2.12.0.txt`.

| Test | Result |
|---|---|
| Typecheck | **PASS** — 0 errors |
| Offline suite (SQLite, both samples) | **PASS** — 178/178 |
| Online suite (real PostgreSQL 16.15) | **PASS** — 56/56 |
| Browser suite (Chromium) | **PASS** — 22/22 |
| Source invariants | **PASS** — 24/24 run; `check-grn.cjs` now 100 |
| Page 1 classified as a GRN list | **PASS** |
| 12 rows detected, 12 extracted, each exactly once | **PASS** |
| All 11 columns to the right row | **PASS** — asserted on rows 1 and 7 separately |
| The Total row is not a GRN | **PASS** |
| No first-row-only behaviour; no dropped rows | **PASS** — 12 distinct ids, 12 distinct sample numbers, each with its own draft |
| All 13 pages classified | **PASS** — all thirteen, none missing |
| Supplier bills and their goods lines | **PASS** — 11 bills, ≥9 goods lines |
| Rate and `per` extracted separately | **PASS** — ₹2,750/QTL on page 2; ₹27.50/kg in the draft |
| Rate never derived from the amount | **PASS** |
| Quantity × rate validated against the amount | **PASS** |
| Figures not shifted into neighbouring columns | **PASS** |
| Links evidence-based; ambiguity flagged | **PASS** — one high-confidence link, one tie, one left unlinked |
| Dispatched vs received weights kept apart | **PASS** — 30,445 kg dispatched against 30,135 kg received on row 1 |
| `purchaseCalc` used, not re-implemented | **PASS** |
| No moisture deduction invented | **PASS** — the list's rupee deduction is reported, not applied as a rate |
| No accounting record before Save | **PASS** — after the 13-page upload: 0 purchases, 0 payments, 0 parties |
| Zero OCR API calls / offline | **PASS** — unchanged from v2.11.0, asserted by the no-network test |
| Text-layer PDF, corrupt, encrypted, oversized, missing engine/language | **PASS** — existing suites, unchanged |
| The exact 13-page PDF committed as a fixture | **NOT DONE, deliberately** — it carries three suppliers' GSTINs, bank accounts, PANs, phone numbers and e-mail addresses. Tests read it from `SOLIVY_GRN_SAMPLE_PDF_MULTI`; the committed fixtures are **masked** OCR text of the list, a tax invoice and a bill of supply, so the row and line parsing is covered on every run |
| Rotated page; multiple list pages; multi-page GRNs; many bills to one row | **NOT VERIFIED** — no fixture has these. The code paths exist (a second list page gets its own totals check; one-to-many links are representable) but are untested |
| `next build`, `next lint` | **NOT VERIFIED** — the npm registry is unreachable here, so Next.js 15.5.27 is not installed |
| Windows, packaged Windows | **NOT VERIFIED** — no Windows machine; no installer in this repository. PowerShell steps: `GRN-AUTOMATIC-OCR-v2.11.0.md` §6 |
| Neon; instrumented byte measurement | **NOT VERIFIED** — the online suite is local PostgreSQL with no GRN upload; recognition still issues no request, which is asserted, but no byte comparison was run |

### What the document actually produced

```
13 pages · 1 list page · 12 rows detected · 12 extracted · 0 unresolved
11 supplier bills · 10 goods lines · 4 bills unlinked · 6 rows unlinked · 1 page unclassified
totals disagree on: bags, net weight, rokdi, deduction
purchases after upload: 0   payments: 0   parties: 0
```

Row 1 → sample 2627-23766, 24.10.2026, truck 0139, PITAMBARA TRADING, 590 bags, 30,135 kg,
freight 0, load 590, rokdi 455, moisture 19.50 %, deduction 2,787.49; bill page 2, invoice 42,
₹2,750/QTL → ₹27.50/kg, dispatched 30,445 kg kept separate.

Four rows had figures wrapped onto the following line; two of those are ambiguous and their rokdi,
moisture and deduction are left empty with the figures listed. One net weight was printed against a
letter and is flagged twice — once as a smudged figure, once by the weight-per-bag check.

## 4. Changed files

- `lib/grn/multi.ts` — **new**: page classification, multi-row list parsing, the totals
  cross-check, column-driven goods-line reading, evidence-based matching, the per-row bridge to
  the existing draft builder, and `bestBill` (both bill parsers run; the layout-specific one fills
  what the generic one leaves empty, so no layout that worked reads worse).
- `app/api/grn/route.ts` — returns `grns[]`, `documents[]`, `matches[]`, `page_classifications[]`,
  `totals` and `counts`; the primary `draft` is unchanged.
- `lib/grn/contract.ts` — normalises all of the above; `normaliseDraft` shared by every row.
- `app/components/GrnImportWizard.tsx` — the consignment table, the totals warning, the per-page
  summary with each bill's rate, and row-by-row review.
- `tests/integration/grn-multi.test.ts` — **new**, 14 tests.
- `tests/fixtures/grn/consignment-list.ocr.txt`, `supplier-tax-invoice.ocr.txt`,
  `supplier-bill-of-supply.ocr.txt` — **new**, masked.
- `tests/ui/grn-entry.tsx`, `tests/ui/grn-wizard.ui.test.ts` — the multi-row response and 2 tests.
- `scripts/check-grn.cjs` — 14 new invariants (100 total).
- `package.json`, `CHANGELOG.md`, `WORKLOG.md`, `ARCHITECTURE.md`, `RELEASE-STATUS.md`, this file.

## 5. Limitations

1. **Four of the eleven bills on this document are not linked to a row**, and six rows have no bill.
   Those four print no vehicle number that could be read, which is the strongest signal; rather than
   guess, they are shown unlinked for you to attach by eye. Manual attach/detach controls are **not** built yet —
   you can review any row and type the bill's values in.
2. **Four bills gave no usable goods line.** Their scans are poor (one at 56 % confidence, mostly
   Devanagari handwriting). They are listed with what was read and flagged for entry.
3. Rotated pages, several list pages in one upload, and a GRN spanning pages are untested.
4. `next build`, `next lint`, Windows packaging and Neon remain unverified, as before.
