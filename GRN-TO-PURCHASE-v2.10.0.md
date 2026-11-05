# SOLIVY Finance v2.10.0 — GRN document to draft purchase (P2)

Baseline: v2.9.0 (clone engine), itself on v2.8.0–v2.8.3. All remain available for rollback.
Schema 30 (two new tables; no business table changed).

## The sample document, as it actually is

`VRHUF-DEEPAKTRA-17.10.pdf` — 2 pages, produced by OpenPDF, **no text layer** (`pdftotext` returns
only form feeds). It is a scan, so everything had to be recognised from the page images.

**Page 1 — Sayaji Industries Limited, "GRN List Report"**, addressed to AKSH ENTERPRISE
(party code 0011000820): Sample No `2627-22603`, GRN Date `17.10.2026`, Truck No `5630`, PO
Supplier `AKSH ENTERPRISE`, Recd. Bags `375`, Net Recd. Wt `21262`, Freight `0`, Load/Unload `0`,
Rokdi `0`, Moist % `11.50`, Deduction for Kg `0.00`. The page itself states: *"THE VALUE OF LOSSES
SUSTAINED BY US DUE TO MOISTURE CONTENT MORE THEN 14.00 %"*.

**Page 2 — "Bill of Supply" from Deepak Enterprises** (Lonara Road Segaon, Dist Khargone; MSME
`UDYAM-MP-28-0001910`; GSTIN `23AAKPA7592B1Z0`; Madhya Pradesh, code 23) to Sayaji: Invoice `274`
dated `13-Oct-26`, delivery note `Shyam Broker`, Motor Vehicle No `GJ04X5630`, destination
Kathwada; one line — `375` packages, Maize, HSN `10059000`, **218.90 qtl at 2,000.00 per qtl =
₹4,37,800.00**, tax NIL; ICICI bank details.

Two findings that changed the design, both from the document rather than from the brief:

1. **The rate is quoted per quintal, not per kilogram.** The brief expected per KG. The unit is
   therefore read off the bill and converted (₹2,000/qtl = **₹20.00/kg**); an unrecognised unit
   blocks the draft instead of being assumed.
2. **The two pages disagree about the weight**, as they should: the bill is for 218.90 qtl
   (21,890 kg dispatched), the GRN records 21,262 kg received — 628 kg less. Both are kept.

## How it works

`POST /api/grn` (multipart) → extract → parse → match → propose. **It posts no accounting entry.**
The reviewed values are saved by the existing `POST /api/purchases`, so there is one accounting
path and the recognised figures cannot reach the ledger without a person agreeing to them.
`POST /api/grn {action:'link'}` then ties the document to the purchase it produced.

- **Extraction** (`lib/grn/extract.ts`): an embedded text layer when the PDF has one, otherwise the
  pages are rendered and recognised locally. No new dependency and nothing leaves the machine —
  it uses poppler (`pdftotext`, `pdftoppm`) and `tesseract` if they are on the machine, overridable
  by `SOLIVY_PDFTOTEXT` / `SOLIVY_PDFTOPPM` / `SOLIVY_TESSERACT`. Measured settings for this scan:
  300 dpi and `--psm 4`; the 150 dpi / `--psm 6` default lost the GRN's numeric cells. When a tool
  is missing it is named, and the screen falls back to manual entry against the rendered pages.
- **Parsing** (`lib/grn/parse.ts`): written against this document pair and against its real
  recognition output, noise included. Every field carries a confidence and the line it came from.
- **Linking the pages**: the GRN prints `5630`, the bill `GJ04X5630`, so a digit-suffix match is
  the primary rule, corroborated by package count and date. Vehicle numbers that positively
  disagree count *against* the link, so bags and dates alone cannot carry it.
- **Draft** (`lib/grn/draft.ts`): maps onto the purchase form, matches the party (GSTIN → name →
  alias), detects duplicates, and prices the draft through `lib/utils.ts purchaseCalc` — the same
  function the purchase screen and the register use.
- **Review screen** (`/grn`): the GRN and the bill side by side with confidences, the points to
  check, the duplicates, the editable draft, a live breakdown, and Save.

### The mapping, and why

| Purchase field | From | Why |
|---|---|---|
| `sample_no` | GRN Sample No | `2627-22603` |
| `purchase_date` | **GRN date** | the brief's requirement; the bill date is kept as evidence |
| `truck_number` | bill Motor Vehicle No | the full registration, not the GRN's `5630` |
| `bags_qty` | GRN Recd. Bags (375, agrees with the bill) | |
| `net_weight` | **GRN Net Recd. Wt** (21,262 kg) | what the buyer weighed in; `purchaseCalc` values the purchase on it |
| `gross_weight` | bill quantity in kg (21,890) | what was dispatched; the difference is shown, never merged |
| `rate` | bill rate converted to per kg (₹20.00) | the unit is read from the page |
| `freight`, `unload_charge`, `driver_rokdi` | GRN columns (0, 0, 0) | |
| `invoice_no`, `hsn`, `goods_description` | bill | `274`, `10059000`, Maize |
| `gst_type` | `NONE` | the page is a bill of supply and states tax NIL |
| `moisture` | **0** | `purchaseCalc` treats `moisture` as a rupee deduction. The GRN's 11.50% is a measurement, and the GRN states deductions apply above 14.00%, so the percentage is reported and no deduction is invented |
| `broker_party_id` | suggestion only | the bill names "Shyam Broker"; matched against parties and flagged for confirmation |

For this document that gives 21,262 kg × ₹20.00 = **₹4,25,240 gross, ₹4,25,240 net payable** (no
deductions on these pages), beside the bill's own ₹4,37,800 for the dispatched quantity — both
shown.

### What is refused rather than guessed

- A GSTIN or IFSC that fails its own validation is **reported as read and left out** of the party
  and bank draft (`23AAKPA7592B120` — the scanner misread `1Z0`; `ICICQ000867` — a Q for the 0).
- A contact line with several numbers proposes the first usable one and reports the rest.
- No party is created, and no purchase is posted, without an explicit confirmation.
- Duplicates are reported before anything is entered twice: the same document (by checksum), the
  same sample number, the same invoice for that party, or the same vehicle on the same date.
- A document already linked to a purchase cannot be discarded — it is part of the audit trail.

## Tests and evidence

`docs/verification/test-run-2026-11-01-v2.10.0.txt` (Node v22.23.4, 2026-11-01):
**104 offline (real SQLite; 102 passed, 2 reported NOT VERIFIED without the sample file) · 14/14
with the real sample PDF · 56 online (real PostgreSQL 16) · 10 browser · 18 legacy scripts ·
typecheck 0 errors — 0 failures.**

`tests/integration/grn-extract.test.ts` asserts, against the committed recognition output of the
real scan: every GRN field including the 14% threshold; the bill's seller, invoice, vehicle, broker
and goods line with the quintal→kg conversion; that misread values are flagged and never corrected;
the page link and its rejection when the vehicle contradicts; the full field mapping and that the
figures equal `purchaseCalc`; every review point; party matching by GSTIN, name and alias; the
party and bank drafts; duplicate detection; an unreadable page; and a rate unit that blocks. Two
further tests run the **real PDF** end to end and the **whole workflow through the real endpoints**
(upload → nothing posted → create party → save purchase → link → re-upload reports duplicates →
discard refused → a second identical purchase refused). They are reported as NOT VERIFIED when
`SOLIVY_GRN_SAMPLE_PDF` is unset, because the sample is a real vendor document and is not
committed; they were executed here against it and are in the evidence file.

## Limitations, honestly

1. **Recognition needs poppler and tesseract on the machine.** They are not bundled (the npm
   registry is unreachable in this build environment, and an OCR engine is not something to add
   blind). Without them the screen still works for text-layer PDFs and for manual entry, and names
   what is missing. On a Windows desktop install they must be installed, or the paths set.
2. **One GRN and one bill per document**, and the first goods line only. A multi-consignment GRN
   or a multi-line bill is read but only the first line is proposed.
3. **The parser is written for these two layouts.** Another buyer's GRN or another accounting
   package's invoice will need its own rules; the pipeline reports "not recognised" rather than
   mapping the wrong thing.
4. **Recognition quality is not guaranteed.** On this scan the GSTIN, the IFSC and the bill's own
   printed total were misread — all three are caught by validation or by the line-item arithmetic,
   but a value with no check digit (a weight, a rate) can only be checked by eye. Every figure is
   shown with its confidence and the line it came from for that reason.
5. **The original PDF is optional and stays local.** It is kept in `grn_document_files`, which is
   excluded from synchronisation: a BLOB cannot pass through the change-capture trigger, and
   megabytes of scans do not belong in every device's snapshot. The audit record — checksum,
   recognised text, extracted fields, the link to the purchase — does synchronise.
6. **No scheduled or bulk import**: one document at a time, by a signed-in user.
7. Not run on Neon; no production build or lint (unchanged environment limits).
