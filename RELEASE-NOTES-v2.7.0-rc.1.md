# SOLIVY Finance v2.7.0-rc.1 — Release notes

**Release candidate. Not production-ready:** the gates are listed in `RELEASE-STATUS.md`. Upgrade from v2.6.30 by following `docs/OPERATIONS.md` §4.

## Network and Neon usage
Measured on local PostgreSQL 16; Neon not verified.
- Requests no longer download and re-upload every database file. A wrong-password login fell from 12.3 MB read / 6.6 MB written to about 0.5 KB / 1 KB on a warm instance. A single write fell from 6.6 MB to about 36 KB.
- Storage is now delta, chunked and content-hashed. Writes are atomic in one transaction, guarded by advisory locks and optimistic versions.
- `/api/data` is now read-only and loads per module: the Parties tab dropped from 1.45 MB to 30 KB.
- The admin backup poll pauses while the tab is hidden. Mutations are de-duplicated with an `Idempotency-Key`.

## Security
- Spoofed `x-aksh-*` headers are stripped.
- Sessions are revoked when a password, role or active flag changes.
- Login throttling is shared across instances, and the plaintext-password fallback is gone; any remaining plaintext passwords are hashed on upgrade.
- License gate fixes: admins keep recovery access, and the license and menu checks are evaluated independently.
- Group reports require organization assignment, including for admins.
- Preview framing is limited to same-origin bill previews.
- A central audit log redacts secrets and records before/after diffs.
- Loopback-only TLS opt-out.

## Financial integrity
- Opening a database no longer renumbers bills or silently repairs data. Repairs are explicit admin actions with a dry run (`/api/admin/data-health`).
- Every schema upgrade is preceded by a backup.
- Sync conflicts on financial tables stop for review instead of auto-merging.
- Journal pruning is acknowledgement-based, and a pruned cursor gets 410.
- Payment advice cannot be generated for reversed or non-posted payments.
- Fixed the transfer narration and the Sauda KG/MT unit mismatch.

## Accounting and reports
- A derived double-entry journal (ADR-001) in integer paise, with a trial balance, GL, P&L, balance sheet and cash flow.
- 33 reports grouped as in the reference screenshot, including:
  - AR/AP aging, open invoices and bills;
  - sales and purchases by customer, item and vendor;
  - stock, valuation and open POs;
  - GST outward, inward and summary;
  - TDS, audit log, cash forecast and budget vs actual.
- Reports drill down to the GL, export to CSV, XLSX and PDF, and support favourites. There is also a management package PDF and multi-company Report Groups (no intercompany elimination).

## Documents
- 5 bill templates (Classic, Modern, Boxed, Compact, Minimal), with theme, typography and density settings.
- Live preview, and preferences per user and per company.
- Truck No. is printed after Sample No.
- Moisture/quality is no longer double-counted.

## Operations
- `npm run snapshot:online` handles list, export, import, backups and restore-backup. Every replace is integrity-checked and backed up.
- The old snapshot uploader refuses v2.7 tables.
- New: `.env.example` and `docs/OPERATIONS.md`.
- 81 automated tests: 60 offline, 17 online, 4 UI.

## Known limitations
See the residual risks in `RELEASE-STATUS.md`: the xlsx advisories, the CSP `unsafe-inline`, no lockfile, GST/TDS still pending CA review, and inventory not yet in the GL.
