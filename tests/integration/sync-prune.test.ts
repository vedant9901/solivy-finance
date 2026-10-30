import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/db';
import { pruneSyncJournal, recordAck, historyPruned, ensurePruneSchema } from '../../lib/sync-prune';

function journal(id: number) {
  const d = db('LIVE', id);
  ensurePruneSchema(d);
  for (let i = 0; i < 10; i++) d.prepare("INSERT INTO parties(name) VALUES(?)").run(`P${i}`);
  d.prepare("UPDATE sync_changes SET created_at=datetime('now','-60 days') WHERE seq <= (SELECT MIN(seq)+5 FROM sync_changes)").run();
  return d;
}

test('spoke: only pushed events older than retention are pruned; watermark recorded', () => {
  const d = journal(501);
  d.prepare("UPDATE sync_meta SET paired_url='https://hub.example' WHERE id=1").run();
  const total = (d.prepare('SELECT COUNT(*) c FROM sync_changes').get() as any).c;
  const r1 = pruneSyncJournal(d, { force: true });
  assert.equal(r1.deleted, 0, 'nothing pushed yet → nothing pruned');
  d.prepare('UPDATE sync_changes SET pushed=1').run();
  const r2 = pruneSyncJournal(d, { force: true });
  assert.equal(r2.deleted, 6, 'six old pushed events');
  assert.equal((d.prepare('SELECT COUNT(*) c FROM sync_changes').get() as any).c, total - 6);
  assert.ok(r2.watermark > 0);
});

test('hub: events not yet acknowledged by an active device are kept; stale cursors get 410', () => {
  const d = journal(502);
  const seqs = (d.prepare('SELECT seq FROM sync_changes ORDER BY seq').all() as any[]).map((r) => r.seq);
  recordAck(d, 'laptop', seqs[2]);
  const r = pruneSyncJournal(d, { force: true });
  assert.equal(r.deleted, 3, 'only up to the slowest device acknowledgement');
  assert.equal(historyPruned(d, seqs[1], 500), true, 'device behind watermark must re-baseline');
  assert.equal(historyPruned(d, seqs[2], 500), false);
  assert.equal(historyPruned(d, 0, 1), false, 'v2.6 preflight (cursor 0, limit 1) still allowed');
  assert.equal(historyPruned(d, 0, 500), true, 'new device must baseline');
  recordAck(d, 'laptop', seqs[1]);
  assert.equal((d.prepare("SELECT ack_cursor a FROM sync_device_acks WHERE device_id='laptop'").get() as any).a, seqs[2], 'acks never move backwards');
});

test('prune runs at most once a day unless forced, and sync_device_acks is not itself synchronized', () => {
  const d = journal(503);
  pruneSyncJournal(d, { force: true });
  assert.equal(pruneSyncJournal(d).skipped, 'pruned within the last day');
  recordAck(d, 'x', 5);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM sync_changes WHERE table_name='sync_device_acks'").get() as any).c, 0);
});
