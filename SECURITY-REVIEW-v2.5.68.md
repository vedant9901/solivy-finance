# SOLIVY Finance v2.5.68 — Source Package Safety Review

## Scope
Static review of the source ZIP intended to address antivirus warnings reported for v2.5.67.

## Changes for safer distribution
- Removed Windows `.bat` and `.ps1` installer/launcher scripts from this source ZIP. The prior convenience scripts used hidden PowerShell execution with `-ExecutionPolicy Bypass`; the installer also recursively replaced the app installation directory. These can be legitimate installer behaviors but are common heuristic triggers and deserve explicit review.
- No executable application binaries are included. This is source code, not a compiled Windows installer.
- No `.env` files, databases, private keys, or customer license files are included.
- Added `npm run check:release-safety` to detect prohibited artifacts in the source tree.
- Fixed the transfer regression check to recognize the multi-loan “Select all eligible loans” UI.

## Static checks run in this environment
- Release artifact/secret audit: passed.
- Online login organization checks: 6/6 passed.
- Source TypeScript syntax audit: 78 files checked.
- Security checks: passed.
- Database bridge audit: passed.
- User/organization access checks: passed.
- Inter-company transfer checks: 17/17 passed.
- Sync, TEST-to-LIVE, Money Out, Group MIS, funding transfer and license checks: passed.
- ZIP integrity: verified after packaging.

## Limitations
- No antivirus engine (e.g. Microsoft Defender or ClamAV) was available in this build environment. This review cannot certify the package as virus-free.
- Dependency installation, a complete Next.js production build, and end-to-end tests against the customer's actual Neon/PostgreSQL environment were not completed here.
- Run `npm install` and `npm run build` on a trusted developer machine. Scan the downloaded ZIP with Microsoft Defender. If Defender still blocks it, record the exact detection name and file path in Protection History; do not disable Defender or add broad exclusions.
