# SOLIVY Finance v2.5.24 — MIS Date and Module Cards Patch

Scope is limited to the MIS report screen in `app/page.tsx`.

- Replaced the horizontal report selector buttons with individual responsive report cards. Each card has its own explanation and an Open button; opening a card shows that report's filters, data table and Excel export, with a return-to-modules action.
- Normalized report dates before date filtering/sorting. Supports ISO date/timestamp strings and DD/MM/YYYY or DD-MM-YYYY date strings.
- Avoided UTC `toISOString()` conversion when calculating due dates and local today; prevents a calendar date from shifting because of timezone conversion.
- Report tables render dates consistently as `dd mmm yyyy`.
- Excel date cells are generated from normalized calendar dates, with date formatting retained; column widths remain auto-fitted and filter headers retained.
- No database schema, transaction calculations, payment flows, licensing, login, or unrelated UI modules intentionally changed.

Validation performed in this environment:
- `npm run check:source` — PASS (57 files parsed)
- `npm run check:import` — PASS (6 checks)
- `npm run check:security` — PASS
- `npm run check:license` — PASS
- Full `npx tsc --noEmit` and `npm run build` — NOT VERIFIED because `npm install --no-audit --no-fund` timed out in this environment. Run these two checks locally before LIVE use.
