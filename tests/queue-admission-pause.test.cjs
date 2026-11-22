const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {DownloadQueue} = require('../dist/core/downloads');

async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), description);
}

async function heldFinalization(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'putio-admission-'));
  let held = false, cleanup = 0, queue;
  queue = new DownloadQueue(() => 1, () => {
    if (!held && queue.jobs[0]?.status === 'finalizing') {
      held = true;
      // Engine enqueue/retry holds admission without changing the active job's run intent.
      queue.paused = true;
    }
  }, async () => new Response('data'));
  t.after(async () => { await queue.stopActive(); await fs.rm(dir, {recursive:true, force:true}); });
  await queue.enqueue({id:'fixture', name:'result.bin', size:4}, dir,
    async () => 'https://fixture.invalid', async () => { cleanup++; });
  await until(() => queue.jobs[0]?.status === 'paused' && queue.active.size === 0, 'finalization reached the temporary admission hold');
  return {queue, dir, get cleanup() { return cleanup; }};
}

test('releasing temporary admission pause finishes the same owned download and cleanup', async t => {
  const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0], id = job.id;
  assert.equal(queue.recovery[id].intent, 'run');
  assert.equal(queue.recovery[id].finalization, undefined);
  assert.equal(fixture.cleanup, 0);
  await assert.rejects(fs.stat(path.join(fixture.dir, 'result.bin')), {code:'ENOENT'});
  queue.paused = false;
  queue.pump();
  await until(() => job.status === 'completed', 'run-intent download must not remain parked after admission reopens');
  assert.equal(queue.jobs.length, 1); assert.equal(job.id, id);
  assert.equal(job.verification, 'verified'); assert.equal(fixture.cleanup, 1);
  assert.equal(await fs.readFile(path.join(fixture.dir, 'result.bin'), 'utf8'), 'data');
});

for (const intent of ['paused', 'canceled']) {
  test(`admission reopening preserves ${intent} recovery intent`, async t => {
    const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0];
    queue.recovery[job.id].intent = intent;
    queue.paused = false; queue.pump();
    assert.equal(job.status, 'paused'); assert.equal(queue.active.size, 0);
    assert.equal(queue.recovery[job.id].intent, intent); assert.equal(fixture.cleanup, 0);
    await assert.rejects(fs.stat(path.join(fixture.dir, 'result.bin')), {code:'ENOENT'});
  });
}

test('admission reopening never restarts a stopping queue', async t => {
  const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0];
  queue.stopping = true; queue.paused = false; queue.pump();
  assert.equal(job.status, 'paused'); assert.equal(queue.active.size, 0);
  assert.equal(fixture.cleanup, 0);
});

test('admission reopening does not bypass a retained finalization checkpoint', async t => {
  const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0];
  queue.recovery[job.id].finalization = {phase:'prepared'};
  queue.paused = false; queue.pump();
  assert.equal(job.status, 'paused'); assert.equal(queue.active.size, 0);
  assert.equal(queue.recovery[job.id].finalization.phase, 'prepared');
  assert.equal(fixture.cleanup, 0);
});

test('admission reopening requires the retained source callback', async t => {
  const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0];
  queue.sources.delete(job.id);
  queue.paused = false; queue.pump();
  assert.equal(job.status, 'paused'); assert.equal(queue.active.size, 0);
  assert.equal(fixture.cleanup, 0);
});

test('admission recovery retains the unresolved per-job close guard', async t => {
  const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0];
  queue.uncertainCloses.add(job.id);
  assert.equal(queue.hasUncertainOpen(), false, 'exercise the per-job guard independently');
  queue.paused = false; queue.pump();
  assert.equal(job.status, 'needs-attention'); assert.equal(queue.active.size, 0);
  assert.equal(queue.uncertainCloses.has(job.id), true); assert.equal(fixture.cleanup, 0);
  await assert.rejects(fs.stat(path.join(fixture.dir, 'result.bin')), {code:'ENOENT'});
});

test('admission recovery retains the persisted uncertain-close process guard', async t => {
  const fixture = await heldFinalization(t), queue = fixture.queue, job = queue.jobs[0];
  queue.recovery[job.id].closeUncertainProcess = 'synthetic-process';
  queue.paused = false; queue.pump();
  assert.equal(job.status, 'needs-attention'); assert.equal(queue.active.size, 0);
  assert.equal(queue.recovery[job.id].closeUncertainProcess, 'synthetic-process');
  assert.equal(fixture.cleanup, 0);
  await assert.rejects(fs.stat(path.join(fixture.dir, 'result.bin')), {code:'ENOENT'});
});
