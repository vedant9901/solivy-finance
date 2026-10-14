# SOLIVY Finance v2.5.23 — Purchase numbering and PDF layout candidate

## Changes
- Added `purchases.bill_number` migration. Existing rows are assigned their existing purchase ID in order, producing stable unique numbers from 1 for a fresh database and stable backfilled numbers for existing data.
- New purchase creation allocates the next bill number within the SQLite transaction. If Sample Number is blank, the generated bill number is used as its sample number. Existing manually entered sample numbers remain unchanged.
- Added `Internal Bill No.` toggle to 3rd Party Bill Document Settings (`show_bill_number`). When enabled, the generated internal bill number appears as a separate `Bill No.` metadata row; when disabled it is omitted.
- Reduced the fixed-height empty item table. The table bottom now follows actual content and visible deductions, with a compact minimum height, instead of forcing a 166 mm bottom.
- Kept settings-driven columns and hidden empty metadata values in the PDF route.

## Important limitations
- This is a source candidate, not a certified final build. A full `npm install`, `npm run build`, generated-PDF visual regression, local LIVE/TEST test, and Vercel/Neon end-to-end test have not been run in this environment.
- The existing project still has SQLite-dependent APIs. This patch does not complete the full Neon/PostgreSQL migration.
- Backfilled bill numbers use the existing purchase IDs so historical ledger references and purchase IDs are not changed. For imported rows that bypass the normal purchase creation API, the PDF uses the purchase ID as a fallback bill number.
- Back up the full project and databases before testing. Verify with a copy first.
