# Vendor Outstanding Fix – v2.5.11

Vendor outstanding is calculated from the actual posted vendor payments (`payments.amount`), not only from payment allocations.

Legacy/CSV payments that were posted without bill allocations are automatically reconciled FIFO against the vendor's oldest posted purchase bills when the data API loads. This makes both the vendor total and pending purchase-bill list agree with the actual posted payments.

Reversed payments are excluded from outstanding and their allocations are removed by the existing reversal logic.

No other financial module logic is intentionally changed.
