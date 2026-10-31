# SOLIVY Finance v2.8.2 — P0 API compatibility, and the reported `/api/data` 404

Baseline: `SOLIVY-Finance-v2.8.0-SaaS-REDESIGN-SYNC-FIX`, unchanged. v2.8.1 (sync repair) and this
release are built on it. Nothing was removed or replaced.

## Root cause of the 404 — found, and it was mine

`app/api/data/route.ts` **was missing from the `SOLIVY-Finance-v2.8.1-SYNC-REPAIR.zip` I delivered**.
Anything built or deployed from that package answers `GET /api/data` with 404, because the route
file is not there. The source was never wrong; the package was.

The cause is the command I used to stage that release:

```
tar --exclude=data …          # matches a directory named "data" at ANY depth
```

It was meant to exclude the runtime `./data` directory, and it also silently dropped
`app/api/data/`. Verified:

| Package | `app/api/data/route.ts` |
|---|---|
| v2.7.1, v2.7.2, v2.7.3, **v2.8.0** | present |
| **v2.8.1** | **absent** — the only pre-existing file it lost |
| v2.8.2 (this release) | present, verified on the ZIP after extraction |

Fixed by anchoring the excludes (`--exclude='./data'`) and by verifying the package before shipping
it (below). Nothing else was missing from v2.8.1: a file-by-file comparison against the checkout
shows that one file and nothing more.

**If you are on v2.8.1, replace it with this build.** v2.8.0 is unaffected and remains a valid
rollback.

## The source itself was never missing an API

Three checks, all green, which is why the 404 could not be reproduced by running the code:

1. **Route inventory against the v2.8.0 ZIP.** v2.8.0 ships 68 route modules exporting 110 HTTP
   methods. This build has 69 / 112 — the only difference is the added `app/api/sync/rejects`
   (GET, POST) from v2.8.1. **Routes lost: 0. Exported methods lost: 0.**
2. **`/api/data` is present and exports GET** (`app/api/data/route.ts`).
3. **The literal request runs end to end** through the real middleware and route:
   `GET /api/data?mode=LIVE&company_id=2&modules=core,parties,accounts` → **HTTP 200** for an
   authorised user of organisation 2, in LIVE and in TEST; `parties` and `accounts` present,
   unrequested modules absent, ETag issued; unauthenticated → refused, never 404 and never data;
   a query parameter for another organisation cannot change the session's organisation.
   Test: `tests/integration/api-compat.test.ts`.

Middleware cannot produce a 404: it only calls `NextResponse.next`, `json` (400/401/402/403/413) or
`redirect`. There is no rewrite anywhere in the application and no catch-all route.

### A second packaging defect, found and fixed

The container image could not serve anything either. The Dockerfile's runtime stage copied only
`.next`, `public`, `package*.json` and `node_modules`, while `npm run start` is
`node scripts/ensure-local-secret.cjs && next start`. With `scripts/` not copied, the container died
on startup with "Cannot find module", and `next start` would also have run without the project's
`next.config.mjs`. Both files are now copied (`Dockerfile`). Reviewed, not built — the npm registry
is unreachable in this environment.

## What was added so this cannot recur silently

- **`scripts/api-route-manifest.json`** — the baseline API surface: every route and every exported
  HTTP method (69 / 112).
- **`scripts/check-api-routes.cjs`** (`npm run check:api-routes`) — fails if any route or method in
  the manifest is missing. It takes a directory argument, so it can be run **against an unpacked
  release**: a route that exists in git but was dropped from the package fails there too. It is part
  of the `scripts/check-*.cjs` release gate.
- **`scripts/check-release-package.mjs`** (`npm run check:release-package -- <dir>`) — compares an
  unpacked release with this checkout file by file and fails on anything missing, then runs the API
  surface guard over it. Run against the v2.8.1 package it reports the missing
  `app/api/data/route.ts` immediately. **Every release ZIP is now verified with this after
  extraction, before it is delivered.**
- **`scripts/check-api-live.mjs`** (`npm run check:api-live -- <base-url> [session-cookie]`) — probes
  a **running** deployment and prints the status of every GET route, listing the ones that answer
  404. This is how to identify the missing routes in the build that failed, rather than guessing.
  Read-only; it sends no mutations and prints no credential.
- **`tests/integration/api-compat.test.ts`** — four guarantees in CI: every route module exports at
  least one method; `/api/data` exports GET; **every API path the interface fetches resolves to a
  route that exports the method it uses** (collected from the source, not a maintained list); and the
  reported request plus organisation/environment isolation behave correctly.

### If a deployment still returns 404

Run, from this release:

```
npm run check:api-routes                                   # the source/package surface
npm run check:api-live -- https://your-site.example         # the running build
```

If `check:api-routes` passes and `check:api-live` reports 404s, the deployed artefact is not this
source: rebuild and redeploy from a checkout containing `app/api` in full, then run
`node scripts/check-api-routes.cjs <unpacked-release-dir>` on the artefact before deploying it.

## Also in this release

`applyLocal` — the device-side apply of one sync event — moved from `app/api/sync/run/route.ts` to
**`lib/sync-apply.ts`**, unchanged. In v2.8.1 the quarantine retry path imported it from the other
route module; a route importing another route is exactly the kind of coupling that can go wrong when
a build packages routes, so both routes now import the library instead. Behaviour is identical and
the 44 online sync tests still pass.

## P1 (sync) status

The P1 list in this brief is the work delivered in **v2.8.1** and carried forward here: per-item
rejection instead of batch abort, one shared table-eligibility rule, the deterministic
absent-on-both-sides rule, the quarantine with a safe retry path, correlation-id diagnostics, no
duplicate financial entries on retry, and LIVE/TEST and organisation isolation. The 12-point gate and
its named tests are in `SYNC-REPAIR-v2.8.1.md`; all of it re-ran green in this release.

## Evidence

`docs/verification/test-run-2026-10-31-v2.8.2.txt` (Node v22.23.4, 2026-10-31):
**84 offline (real SQLite) · 44 online (real PostgreSQL 16) · 10 browser · 16 legacy scripts ·
typecheck 0 errors — 0 failures.**

## Risks / not verified

1. **If the 404 you saw came from a build older than v2.8.1**, it has a different cause than the one
   proven above, and I have not identified it; run `npm run check:api-live` against that deployment
   and send me the output. For anything built from v2.8.1, the cause is the missing file documented
   above and this release fixes it.
2. **No production build or lint.** The npm registry is unreachable in this environment, so Next.js
   15.5.27 is not installed; routes are exercised through a `next/server` shim and an esbuild
   bundle. The Dockerfile fix is therefore reviewed, not built.
3. **Neon is not exercised** — the online results are from a local PostgreSQL 16.
4. The organisation-2 test seeds organisations until id 2 exists; on a database where id 2 is
   already taken by another organisation it tests the equivalent organisation, not literally id 2.
5. Three legacy check scripts asserted on source text that moved in v2.8.1/v2.8.2 and were
   re-pointed at the current location, asserting the same property:
   `check-sync-company-settings.cjs`, `check-user-org-conflicts.cjs` (both now read
   `lib/sync-apply.ts`), and the two re-pointed in v2.8.1.
