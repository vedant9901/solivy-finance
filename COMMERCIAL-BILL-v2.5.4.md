# Commercial Bill v2.5.4

The commercial bill renderer is based on the supplied one-page invoice reference PDF `02-AKSH - Copy.pdf`.

Reference structure retained:
- INVOICE heading
- client/company block at upper left
- invoice/reference/date fields at upper right
- Buyer (Bill to) block
- goods table with Sl No, Description of Goods, HSN/SAC, Quantity, Rate, per, Amount
- Less adjustment lines
- Total
- Amount Chargeable (in words)
- Declaration / E. & O.E.
- Company's Bank Details
- authorised signatory
- computer-generated footer

Document-specific settings are stored in each company's SQLite database. They control display and document-only counting; they do not mutate the underlying accounting transaction.

Third-party bills use the same purchase transaction but substitute the selected active third party for the Buyer (Bill to) block. The source vendor/purchase party and accounting ledger remain unchanged.
