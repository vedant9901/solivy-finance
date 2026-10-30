# SOLIVY Finance v2.6.21 — Purchase Bill Renumbering

- Saving a changed `Purchase bill number: start after` setting renumbers existing purchases by purchase ID in ascending order, starting at configured value + 1.
- Third-party bills display the linked purchase's current `bill_number`.
- Existing purchase IDs, foreign keys, supplier invoice numbers, and accounting rows are preserved.
- Renumbering runs in one database transaction; a failure rolls back both settings and numbering changes.
- An audit log entry records the old/new starting value and count of affected purchases.
- New purchases continue from the maximum assigned bill number.

Example: set start-after to 15; existing purchases become 16, 17, 18... in purchase ID order.

Important: printed/shared documents may show old numbers. Keep a database backup and notify users before applying a renumbering.
