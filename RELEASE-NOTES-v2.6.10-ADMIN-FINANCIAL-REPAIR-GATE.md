# SOLIVY Finance v2.6.10 — Admin Financial Repair Gate

## Baseline
Built from the `SOLIVY-Finance-v2.6.9-FINANCIAL-REPAIR-TDS` package, which was based on the requested v2.6.8 Admin Financial Repair baseline.

## Changes
- `Post a verified balance correction` is available to administrators after running Financial Repair diagnostics.
- The server now independently checks for suspicious finance receipt/reversal entries before posting any balance correction. If any matching suspicious entries are found, the request is rejected before a backup or financial mutation is made.
- The restriction is enforced by the API, not only by the UI, so a direct API request cannot bypass it.
- When no suspicious entries are found, the existing verified correction flow remains: compare against the actual bank statement, provide a reason, type the confirmation phrase, create a pre-change database backup, post a compensating CREDIT/DEBIT transaction, and record an audit log.
- Original financial history is not silently deleted or rewritten.

## Checks performed
- `node scripts/check-financial-repair-tds.cjs` — passed, including new suspicious-entry gate checks.
- `node scripts/check-security.cjs` — passed.

## Validation limitation
A full Next.js production build and live database/backup-restore test were not run in this environment because project dependencies are not installed in the package workspace. Run `npm install` and `npm run build` in the release environment before deploying to production.
