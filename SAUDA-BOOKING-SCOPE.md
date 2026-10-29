# SOLIVY Finance v2.5.78 — Sauda Booking

Based on the v2.5.77 Party/Organization Scope baseline.

## Included
- New `TRADER` and `SUPPLIER` user roles in user management.
- Trader/Supplier login defaults to Dashboard + Sauda Booking; their navigation is restricted to those entries.
- Sauda Booking screen for commodity, purchase-from party, selling-to party, optional broker/third party, quantity/unit, purchase and sale rates, vehicle, route, delivery date, estimated expenses and notes.
- Indicative expected profit calculation and Sauda Register.
- Organization- and LIVE/TEST-scoped `saudas` table and API.
- Server-side role validation for Sauda API; validates active party references and prevents selecting the same party on both sides.
- Sauda records do not automatically post purchase/sales invoices or accounting entries.

## Verification
- TypeScript syntax parse passed for 81 app/lib TS/TSX files.
- `node scripts/check-source.cjs` passed source/dependency/Tailwind audit.
- Full Next.js production build and live SQLite/PostgreSQL runtime tests were not run in this environment.

## Current scope limit
This is the initial booking/register stage. Delivery execution, multiple vehicle allocations, partial customer/supplier payments, invoice linking, approval workflow, and realized-profit reconciliation are not implemented in this version.
