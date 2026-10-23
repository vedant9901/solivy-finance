# SOLIVY Finance v2.5.65 — Group MIS Runtime Declaration Fix

## Fix
- Removed the duplicate `export const runtime` declaration from `app/api/group-mis/route.ts`. The route keeps the existing Node.js runtime and force-dynamic settings at the top of the file.
- Updated package version to 2.5.65.

## Verification
- Confirmed `app/api/group-mis/route.ts` contains exactly one runtime declaration.
- Run `npm run build` in the target Windows/build environment to verify the full Next.js build.
