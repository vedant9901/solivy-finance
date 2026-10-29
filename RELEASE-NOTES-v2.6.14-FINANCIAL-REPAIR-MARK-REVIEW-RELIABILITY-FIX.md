# SOLIVY Finance v2.6.14 — Financial Repair Mark Reviewed Reliability Fix

## Changes
- Removed pre-change SQLite file backup from the review-only action. Marking an entry reviewed changes review metadata and audit logs, not financial transactions; backup filesystem failures could block the action before it was saved.
- Audit records now identify the action as review-only and use the authenticated `x-aksh-user` header for reviewer identity.
- The UI shows a saving state, verifies the API response, refreshes diagnostics, and displays a visible success or error alert.
- The original finance transaction is not changed by marking it reviewed.
- Review reason minimum is aligned to the API at 10 characters.

## Verification status
Source changes are applied to the supplied v2.6.13 source baseline. ZIP integrity and static checks should be run after packaging. A full production build and live database integration test are not claimed unless executed separately.
