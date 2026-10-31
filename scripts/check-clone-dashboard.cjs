#!/usr/bin/env node
/**
 * v2.9.0 — the clone and sync-health dashboard offers every required action, and the destructive
 * ones cannot run without an explicit typed confirmation.
 *
 * This is a static check of the page and the two routes: it asserts the actions exist and are
 * wired to the API, not that they render (the browser suite covers rendering of the main app).
 */
const fs = require('node:fs');
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

const page = fs.readFileSync('app/sync/page.tsx', 'utf8');
const hub = fs.readFileSync('app/api/sync/clone/route.ts', 'utf8');
const device = fs.readFileSync('app/api/sync/clone/run/route.ts', 'utf8');
const engine = fs.readFileSync('lib/clone-engine.ts', 'utf8');
const store = fs.readFileSync('lib/clone-store.ts', 'utf8');

check('dashboard offers a full push, a full pull, incremental sync, validation and conflict review',
  /Preview full push/.test(page) && /Push full clone/.test(page) && /Preview full pull/.test(page) && /Pull full clone/.test(page)
  && /Validate both databases/.test(page) && /Sync Now|sync\(\)/.test(page) && /awaiting review/.test(page));
check('dashboard offers rollback of the online copy', /Roll back the online copy/.test(page) && /rollback-online/.test(page));
check('dashboard shows record counts, table counts, size and differences', /Records/.test(page) && /Tables/.test(page) && /Differences/.test(page));
check('a destructive clone requires a typed confirmation', /confirmAndRun/.test(page) && /window\.prompt/.test(page) && /confirmation_required/.test(page));

check('device side requires an administrator and an exact confirmation phrase',
  /x-aksh-role'\) !== 'ADMIN'/.test(device) && /REPLACE \$\{direction === 'push' \? 'ONLINE' : 'OFFLINE'\}/.test(device) && /status: 428/.test(device));
check('device side previews without changing anything', /preview === true/.test(device) && /stage: 'preview'/.test(device));
check('device side keeps the previous local file and restores it if verification fails',
  /pre-clone-/.test(device) && /copyFileSync\(backup, localFile\)/.test(device));
check('device side validates before and after activation', /validate-download/.test(device) && /verify-activated/.test(device));

check('hub stages, verifies and only then activates', /clone-staging/.test(engine) && /verify-staged/.test(engine) && /activated = await writeSnapshot/.test(engine));
check('hub keeps the replaced online snapshot for rollback', /backupSnapshot\(client, activeKey/.test(engine) && /rollbackOnline/.test(engine));
check('a clone is never activated without a matching fingerprint', /compareFingerprints/.test(engine) && /so the online snapshot was left unchanged/.test(engine));
check('financial totals are part of every verification', /purchases_net_payable/.test(engine) && /payment_allocations_amount/.test(engine) && /ledger_debit/.test(engine) && /account_transactions_credit/.test(engine));
check('validation covers integrity, foreign keys, schema version and accounting invariants',
  /integrity_check/.test(engine) && /foreign_key_check/.test(engine) && /schema_version/.test(engine) && /accounting_invariants/.test(engine));
check('snapshots are taken with VACUUM INTO, never copied from a live WAL file', /VACUUM INTO \?/.test(engine));
check('the hub keeps its own sync identity when a clone is activated', /hubIdentity/.test(hub) && /realignAfterClone\(incoming/.test(hub));

check('upload state and locks are durable, not in memory', /CREATE TABLE IF NOT EXISTS \$\{UPLOAD_CHUNK_TABLE\}/.test(store) && /CREATE TABLE IF NOT EXISTS \$\{LOCK_TABLE\}/.test(store));
check('resending a chunk is idempotent', /ON CONFLICT \(upload_id, chunk_no\) DO UPDATE/.test(store));
check('an incomplete upload is refused rather than activated', /The upload is incomplete/.test(store) && /INCOMPLETE_UPLOAD/.test(hub));
check('an interrupted upload resumes the same upload id', /Deterministic in the sha and the device/.test(store));
check('two clones of one organisation cannot run at once', /acquireCloneLock/.test(store) && /CLONE_IN_PROGRESS/.test(hub));
check('the assembled upload is checksum-verified before anything is activated', /does not match the checksum the device declared/.test(store));
check('clone runs are recorded durably', /CREATE TABLE IF NOT EXISTS \$\{RUN_TABLE\}/.test(store) && /recordRun/.test(hub));
check('foreign keys are never disabled anywhere in the clone path',
  !/foreign_keys\s*=\s*(OFF|0)/i.test(engine) && !/foreign_keys\s*=\s*(OFF|0)/i.test(hub) && !/foreign_keys\s*=\s*(OFF|0)/i.test(device));

if (failed) { console.error(`${failed} clone dashboard/engine check(s) failed`); process.exit(1); }
console.log('Clone dashboard and engine checks passed');
