# SOLIVY Finance v2.5.77 — Party Master Organization Scope

## Requirement
A user sees Party Master and Third Party records only from the currently selected organization and other organizations explicitly assigned to that user for the selected LIVE/TEST environment. Example: a user assigned to organizations 1 and 2 can see those organizations’ parties and third parties, never organization 3 records.

## Changes
- Party mirror discovery now uses `user_companies` grants for every role; ADMIN role alone does not expose all organizations.
- The data response filters local master rows and mirrored rows to the assigned organization set, hiding stale mirrors after an assignment is removed.
- Third parties now have source organization/source record metadata and are mirrored from assigned organizations only.
- Party Alias API lists only local plus currently assigned organization master records.
- Mapped third parties are read-only from the destination organization; edit them at the source organization.
- Existing records are retained in storage but hidden when the user no longer has a grant; no master records are deleted.

## Validation status
Static checks and ZIP integrity are run for this package. Full dependency installation, Next.js production build, and multi-user database integration testing are still required before production deployment.
