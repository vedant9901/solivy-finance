# SOLIVY Finance v2.5.55 — Offline/Online Sync Foundation

This release adds an initial incremental sync foundation:
- SQLite change journal triggers for business tables.
- Online admin pairing creates a scoped, revocable token for one company and one environment.
- Manual sync via `/sync`; optional auto sync when connectivity returns and every five minutes while that page remains open.
- Two-way exchange with idempotent event IDs and optimistic conflict detection.
- Separate LIVE and TEST pairing; cross-environment sync is rejected.
- New offline AUTOINCREMENT rows are assigned a device-specific high ID range when sync runs to reduce ID collisions.

This is a **candidate foundation**, not yet production-certified. Existing history is not automatically backfilled; complete an initial migration first. File attachments, desktop-background sync while the app is closed, and automated conflict resolution are not included. Run a full production build and SQLite/PostgreSQL integration tests before LIVE deployment.
