# SOLIVY Finance v2.11.2 — the OCR engine would not load on your installation

Baseline: v2.11.1. No schema change, no new network call, no sync change.

## 1. What your log actually says

```
· Page 1 could not be recognised (undefined is not a function).
· Page 2 could not be recognised (undefined is not a function).
```

That is not OCR failing to read the pages. **The engine never loaded**, so every page threw the
same JavaScript type error, both pages were recorded as unreadable, and the wizard did what it is
designed to do when no engine is usable — showed the pages for manual entry. The banner you saw
("the OCR engine could not be used on this machine") was correct; it just could not tell you why.

The cause is module loading, not the engine. `lib/grn/ocr-wasm.ts` loaded the engine with

```ts
import { createRequire } from 'node:module';
…
const factory = createRequire(base)(info.core!);
```

Once that file has been through the Next.js server bundler, the named import from `node:module`
can come back **undefined**. Calling it then produces exactly `undefined is not a function`. It
works here, under the test runner, which is why every suite passed and your installation still
failed: the two load the same file through different module systems.

## 2. The fix

**One guarded route is not enough, so there are now five**, each checked with `typeof` before it is
used, tried in order, and each one's outcome recorded:

1. `createRequire` from the static `node:module` import — correct when the bundler leaves it alone.
2. `createRequire` from `await import('node:' + 'module')` — the same thing fetched at run time, so
   a rewritten static import cannot remove it.
3. the module's own `require`, where this file really is CommonJS;
4. `require` fetched through `eval`, for a build that rewrote the identifier;
5. `await import('file://…')` of the engine file itself — the ESM route of last resort.

Each route is **verified independently**: `SOLIVY_GRN_OCR_LOAD_ROUTES` restricts which may be used,
and a test loads the engine through each one on its own. All five work on this machine, so whichever
one your build breaks, four remain. The same setting lets an odd build be pinned to a route that
works, without a new release.

**The engine's own interface is now checked before it is used.** `FS.writeFile`, `TessBaseAPI`,
`Init`, `SetImageFile`, `Recognize`, `GetUTF8Text` and `SetPageSegMode` are each confirmed to exist,
and a module that loads but exports the wrong shape is reported as that rather than invoked. No path
through this code can produce a bare `undefined is not a function` again.

**The failure now tells you what to do.** Instead of a type error repeated per page, you get one
note naming the file, stating that it is present, that this is a module-loading problem and not a
missing engine, and listing every route that was tried with its reason. The wizard's "Show how this
document was read" panel lists them too.

**Two further faults found while fixing this:**

- A cached engine was reused even when the configured folder had changed, so a diagnostic could
  report success for an engine that is no longer there. It is now reused only while it is still the
  engine the current settings point at, and the self-test reports what is on disk now.
- When no bill was recognised, the party warning read `No existing party matches "the seller"` — a
  placeholder presented as a name. It now says no seller was read and the party must be chosen by
  hand.

## 3. Check your own machine in one request

```
GET /api/grn?selftest=1
```

It loads the engine and reports the version, how the file was loaded, the folder, the language data,
your Node version and platform — or, on failure, every route that was tried and why each failed. It
uploads nothing, reads no document, stores nothing and answers 503 when the engine cannot be used.

In the browser, signed in to SOLIVY, open:

```
http://localhost:3000/api/grn?selftest=1
```

A healthy machine answers like this:

```json
{"ok":true,"engine":{"kind":"bundled-wasm","available":true,"languages":["eng"],
 "dir":"…/vendor/tesseract-wasm"},"version":"5.1.0-288-g2a9c1",
 "load_route":"createRequire(node:module)","load_attempts":[],"error":null,
 "node":"v22.23.4","platform":"linux-x64"}
```

**Please send me that output.** If `ok` is false it names the exact cause on your machine; if it is
true, the engine loads there and the upload will now recognise the pages.

## 4. Verification

Evidence: `docs/verification/test-run-2026-11-02-v2.11.2.txt`.

| Test | Result |
|---|---|
| Typecheck | **PASS** — 0 errors |
| Offline suite (SQLite, sample set) | **PASS** — 164/164 |
| Online suite (real PostgreSQL 16.15) | **PASS** — 56/56 |
| Browser suite (Chromium) | **PASS** — 20/20 |
| Source invariants | **PASS** — 24/24 run; `check-grn.cjs` now 86 |
| Each of the five load routes, driven on its own | **PASS** — 5 tests, all five load the engine and report their version |
| A total load failure names every attempt, never a bare type error | **PASS** |
| A module that exports the wrong shape | **PASS** — reported, not called |
| Cached engine not reused after the folder changes | **PASS** |
| `GET /api/grn?selftest=1` healthy and failing | **PASS** — 200 with the route, 503 with the reason; creates nothing |
| The real sample end-to-end through the bundled engine | **PASS** — both pages, every field |
| **That this fixes *your* installation** | **NOT VERIFIED** — I cannot reproduce a Next.js server build here (the npm registry is unreachable, so Next.js 15.5.27 is not installed). The failure mode is identified from your error message and all five routes are proven to work under the module system available here. The self-test in section 3 is how we confirm it on your machine |
| `next build`, `next lint` | **NOT VERIFIED** — both need the uninstalled Next.js |
| Windows, packaged Windows | **NOT VERIFIED** — no Windows machine; no installer in this repository |
| Neon; instrumented byte measurement | **NOT VERIFIED** — as before |

## 5. Changed files

- `lib/grn/ocr-wasm.ts` — `loadFactory` with five guarded routes and recorded attempts;
  engine-interface checks; `loadDiagnostics()`; `engineSelfTest()`; cached engine tied to its
  folder; `SOLIVY_GRN_OCR_LOAD_ROUTES`.
- `lib/grn/extract.ts` — the engine-load failure reported once with its real reason, and the load
  route and attempts carried into the diagnostics.
- `app/api/grn/route.ts` — `?selftest=1`.
- `app/components/GrnImportWizard.tsx` — the attempted routes shown in the diagnostics panel.
- `lib/grn/contract.ts` — `load_route`, `load_attempts`.
- `lib/grn/draft.ts` — the party warning when no seller was read.
- `tests/integration/grn-ocr-loader.test.ts` — **new**, 9 tests.
- `scripts/check-grn.cjs` — 10 new invariants (86 total).
- `package.json`, `CHANGELOG.md`, `WORKLOG.md`, `ARCHITECTURE.md`, `RELEASE-STATUS.md`, this file.

## 6. If it still fails after this

Send the `?selftest=1` output. If it reports a route that works, recognition will work. If every
route fails there, the message will name the reason for each — and the fallback remains what you saw:
the pages are shown at full resolution and the values can be typed in, with the totals calculated by
the same rules as the purchase form, and nothing is ever guessed.

As an interim measure, if the self-test names one route that succeeds, pin it:

```
SOLIVY_GRN_OCR_LOAD_ROUTES=import-url
```

(valid values: `createRequire`, `import-module`, `require`, `eval-require`, `import-url`.)
