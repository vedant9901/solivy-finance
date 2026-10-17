# SOLIVY Finance v2.5.41 — Purchase layout and mobile fixes

- Recent Purchases now appears below the complete Purchase / Sample form instead of in a right-hand sidebar.
- Purchase form and history cards use `min-w-0` to avoid grid/flex overflow on narrow screens.
- Recent Purchases is horizontally scrollable on mobile, with a concise hint for wide tables.
- Header uses responsive stacking on small screens.
- Existing Tailwind utility styling and global theme colors are preserved; no financial logic or APIs were changed.

Validation performed: source parsing and ZIP integrity. Full production build and live/offline end-to-end tests must still be run in the target Windows environment.
