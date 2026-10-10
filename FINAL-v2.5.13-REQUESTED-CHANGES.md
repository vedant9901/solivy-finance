# SOLIVY Finance v2.5.13 — requested changes

Baseline: v2.5.12. Existing SQLite persistence and LIVE/TEST separation are retained.

## Payment Advice
- Displays Net Weight, Bags / Packages, and Rate / Kg to two decimals in that order.
- Gross Weight, Gross Amount, Gross Settlement, Allocated to Bills, and Unallocated / Advance are hidden by default and are configurable in Document Settings.
- Discount line can show its percentage.
- Payment Date and UTR / Reference can be shown below Amount in Words; the header date is optional.
- Settlement totals continue to use saved payment and allocation values; display toggles affect presentation, not the accounting calculations.

## Brokers
- Broker is a Party Type in Add Party, with contact number and email.
- Purchase / Sample allows an optional broker chosen from parties with Party Type BROKER.
- Broker name/contact/email are included in commercial bill PDF when a broker is selected.

## Validation and sharing
- Server-side syntax validation added for party email, phone, GSTIN, PAN, bank account number and IFSC, plus company bank account and sales GSTIN fields. These are format checks, not a guarantee of legal/tax correctness; verify special cases with the bank/CA.
- Added react-icons; payment and purchase records have icon-only PDF, email-draft and WhatsApp-share actions. Browser security does not allow a `mailto:` draft to auto-attach a downloaded PDF; attach the PDF manually to email. WhatsApp share opens a prefilled text message.

## Offline
- SQLite data directory and existing local installer are unchanged. `react-icons` is a standard build dependency and must be installed by `npm install` on the offline machine (or during installer setup while connected). No online API is required for local database usage; email/WhatsApp actions require internet access.

## Verification status
- Source-level review and SQL placeholder count checks were performed. A full `next build` must be run after dependency installation; do not interpret source review as a successful production build.
