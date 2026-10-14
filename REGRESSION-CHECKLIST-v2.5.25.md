# SOLIVY Finance v2.5.25 — manual regression checklist

Use a copied TEST database. Do not test destructive actions on the only LIVE database.

- [ ] Setup/login/logout, invalid login throttle, password reset and expired session.
- [ ] Create user with 11-character password (must reject); 12-character password (must accept); default password is never generated.
- [ ] Verify each role sees only assigned modules; call `/api/data` as a restricted user and confirm unassigned arrays are empty and contact/bank details are not exposed.
- [ ] Verify company switching and LIVE/TEST separation; create sample records in TEST and confirm none appear in LIVE.
- [ ] Create purchase with due date +30 days; verify date remains the correct calendar date in Asia/Kolkata.
- [ ] Edit purchase with no receivable receipts; verify same receivable record remains. Try editing a purchase with a receivable receipt; must be blocked without changing any rows.
- [ ] Post two partial receivable receipts with different TDS rates; verify total received, TDS amount, weighted average TDS rate, bank credits and status.
- [ ] Attempt reversal of a receivable with multiple receipt transactions; must be blocked without modifying rows.
- [ ] Import CSV/XLSX with rate 22.50, GST 2.5%, discount 2.5%, and weight 1250.75; preview should preserve decimals.
- [ ] Purge/clear TEST data; confirm pre-destructive backup file is created before data changes.
- [ ] Promote TEST to an empty LIVE database and verify account movements, third parties, company settings and audit/import tables where present.
- [ ] Restart the application and verify persistence, PDFs, Excel exports, ledgers, dashboard and Purchase & Rate Analysis bill-level earnings/receivable profit/as-of-today reporting.
- [ ] Verify existing LIVE database and all company/mode files are backed up before applying this source update.
