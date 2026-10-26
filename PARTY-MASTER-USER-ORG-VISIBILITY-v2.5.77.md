# SOLIVY Finance v2.5.77 — Party Master user-organization visibility

## Change
Mapped party mirrors are returned by `/api/data` only when the signed-in user has access to the party's source organization in the active environment (LIVE or TEST). Administrators retain the existing behavior of seeing mirrors from active organizations.

Native parties belonging to the selected organization remain visible. Hidden mapped party mirrors are not deleted from the database because transactions may still reference their IDs; they are simply excluded from the current user's party data response and therefore from Party Master and party pickers fed by that response.

## Verification
- Source-level assertion confirms returned party list is filtered against the environment-specific `partySources` access list.
- This source package has not been dependency-installed or subjected to a full production build or live multi-user integration test. Test with two users mapped to different organizations in both LIVE and TEST before production rollout.
