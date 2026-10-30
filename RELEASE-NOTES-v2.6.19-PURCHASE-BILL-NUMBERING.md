# SOLIVY Finance v2.6.19 — Purchase Bill Numbering

- Purchase register now displays the internal bill number separately from sample number and supplier invoice number.
- Company / TDS Settings adds “Purchase bill number: start after”. Enter the last number already used; the next new purchase uses the following number.
- New numbering ignores SQLite AUTOINCREMENT sequence values, which track row IDs and caused huge internal bill numbers.
- Existing databases receive a backward-compatible setting-column migration. If existing bill numbers are clearly corrupted by an AUTOINCREMENT value (over 1,000,000 and over 1,000 times the purchase count), and no start-after number is configured, they are renumbered sequentially by purchase ID. This does not alter purchase row IDs or supplier invoice numbers.
- ZIP/source patch prepared; full Next.js production build and accounting regression tests have not been run in this environment. Back up the database before deployment.
