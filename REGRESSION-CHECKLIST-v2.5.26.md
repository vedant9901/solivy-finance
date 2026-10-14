# SOLIVY Finance v2.5.26 — regression checklist

Run only against a copied database / TEST environment. Do not use the only copy of LIVE data.

## Build
- [ ] `npm install --no-audit --no-fund` exits 0. Review/approve only trusted npm install scripts required by this project.
- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run build` exits 0.
- [ ] Start app, log in, switch company and switch LIVE/TEST.

## Tally
- [ ] Save a set of exact ledger names for a test company/environment.
- [ ] Reload the page and verify mappings persist.
- [ ] Export each voucher type to XML and review workbook.
- [ ] Verify debit/credit totals and bill allocations.
- [ ] Import into a BACKUP Tally company and inspect Day Book, Purchase Register, Sales Register, and exceptions.
- [ ] Confirm missing ledger masters and tax ledgers are reported/resolved before using production data.

## Bank statement intake
- [ ] Test original CSV and XLSX from at least two different banks.
- [ ] Test manual column mapping, DD/MM/YYYY and Excel serial dates, debit/credit rows, and balance.
- [ ] Test MT940. Confirm PDF is rejected.
- [ ] Re-import identical statement and verify duplicate protection.
- [ ] Confirm preview/save only stages statement rows and does not alter payments or ledgers.

## Access and deactivation
- [ ] Create a non-admin user with only selected menus and dashboard cards.
- [ ] Verify hidden cards and locked menus behave as assigned.
- [ ] Call restricted APIs directly and verify 403 responses.
- [ ] Verify admin access remains available.
- [ ] Verify last active admin cannot be deactivated/demoted.
- [ ] Verify another active administrator can deactivate/reactivate users.
- [ ] Verify last active organization cannot be deactivated and other organizations can be deactivated/reactivated.
- [ ] Verify no user/company delete action exists in UI or API.
- [ ] Confirm existing sessions after deactivation; session revocation remains a known limitation.

## Secondary backup
- [ ] Configure a local removable drive or network share destination and time.
- [ ] Run manual backup and confirm manifest, admin DB, LIVE/TEST company snapshots.
- [ ] Disconnect destination and verify persistent error details are visible.
- [ ] Reconnect destination and verify retry produces a new backup.
- [ ] Confirm scheduled checks require the app running and admin session polling; test after app restart.
- [ ] Restore a copy into an isolated folder and verify DB integrity; never overwrite the live data directory during this test.

## Existing finance workflows
- [ ] Purchase create/edit, partial payment, reversal, due dates and purchase PDF.
- [ ] Payment create/edit, allocation, TDS, bank account balances and payment advice.
- [ ] Money-in, interest, receivables, funding schedules and reversals.
- [ ] CSV imports/exports, ledger reports, GST/TDS workpapers and dashboard KPIs.
- [ ] LIVE/TEST isolation and TEST-to-LIVE promotion.
- [ ] Backup before destructive operations; verify original database files unchanged.
