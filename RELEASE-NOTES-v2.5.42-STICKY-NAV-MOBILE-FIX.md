# SOLIVY Finance v2.5.42 — Sticky Navigation & Mobile Layout

- Kept the mobile brand/navigation bar sticky at the top.
- Made the company/environment page header sticky beneath the mobile brand row and sticky at the top on desktop.
- Corrected stacking contexts so the drawer and its backdrop appear above the sticky header.
- Restyled the mobile drawer to match the dark navy desktop sidebar with teal active state and accessible contrast.
- Tightened narrow-screen header controls and preserved responsive card/table behavior.
- No API routes, database schema, financial calculations, or license enforcement changed.

Verification: source-level CSS diff and ZIP integrity only. Full Next.js production build and live/offline browser regression must be run in the target environment.
