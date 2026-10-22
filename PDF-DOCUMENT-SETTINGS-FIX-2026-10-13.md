# SOLIVY Finance v2.5.23 — PDF Document Settings Fix

## Changes
- `show_quantity` and `show_net_weight` now independently control their columns. When both are enabled and the purchase has a net weight, both columns render; neither checkbox silently overrides the other.
- `show_declaration` now controls the declaration heading and text.
- Company bank details heading is omitted when no bank details are available, instead of leaving a heading with blank content.
- Existing empty-value checks remain in place: a checked option only prints when its corresponding source value exists.

## Data limitations
The current purchase schema stores `sample_no`, `invoice_no`, `purchase_date`, and `payment_due_days`; it does not store separate buyer-order number, other references, delivery terms, or a separate reference date/number. Those optional settings cannot print meaningful values until the relevant fields are added to Purchase Entry and persisted. The PDF intentionally does not invent values for them.

## Validation
- Manual source diff and syntax-structure inspection: performed.
- Full `npm run build`: not run because dependencies are not installed in this environment.
- PDF rendering and local/online integration tests: not run.
