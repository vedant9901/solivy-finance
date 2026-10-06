# Commercial Bill v2.5.5

The commercial bill renderer is now based directly on the supplied one-page PDF reference.

## Goods description

A purchase now has dedicated fields:
- Description of Goods
- Bags / Packages

The PDF never hard-codes a product name. It prints the saved Description of Goods and, when entered, a second line such as `520 Bags`.

Existing purchases without a description remain blank until edited; no product is invented.

## Layout

- INVOICE heading
- Seller/company block at upper left
- Invoice metadata grid at upper right
- Buyer (Bill to) block
- Sl No / Description of Goods / HSN-SAC / Quantity / Rate / per / Amount table
- Less: deductions inside the goods table body
- Total row
- Amount Chargeable (in words)
- Declaration
- Company's Bank Details
- Authorised Signatory
- Computer Generated Invoice footer

No red/green annotation colours from the supplied screenshot are used in the actual invoice; those colours were treated as markup indicating the client/company and party areas.

## Empty values

Values are omitted when not supplied. GST/PAN/contact/bank/etc. are never rendered as `-` or blank placeholders.
