const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { withEngine } = require(process.env.STAGED_RESOURCE_PACKAGE ? path.join(process.env.STAGED_RESOURCE_PACKAGE, 'tests/helpers/download-resilience-fixture.cjs') : './download-resilience-fixture.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(15); }
  throw Error(`Timed out waiting for ${label}`);
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  const [mode, kind, sizeText] = process.argv.slice(2);
  const size = Number(sizeText);
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 17) % 256;
  const hash = crypto.createHash('sha256');
  for (let n = 0; n < size; n += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, size - n)));
  const expected = hash.digest('hex');
  const cleanups = [];
  const t = { after(fn) { cleanups.push(fn); } };
  let destination, blocked = false, release, gate, armed = false;
  let produced = 0, producerDuringCopy = 0, activeWrites = 0, maxWrites = 0, readsDuringWrite = 0, writes = 0, peak, baseline, timer;
  let phase = 'download'; const maxima = {};
  const sample = () => {
    const memory = process.memoryUsage();
    const slot = maxima[phase] ||= { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    for (const key of Object.keys(slot)) slot[key] = Math.max(slot[key], memory[key]);
    peak = Math.max(peak, memory.rss);
  };
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const file = String(args[0]);
    if (destination && file.toLowerCase().startsWith(destination.toLowerCase() + path.sep) && args[1] === 'wx') {
      const write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => {
        phase = 'copy'; activeWrites++; maxWrites = Math.max(maxWrites, activeWrites); writes++;
        try {
          if (armed) { armed = false; blocked = true; await gate; }
          else if (writes <= 4) await sleep(5);
          if (typeof writeArgs[2] === 'number') writeArgs[2] = Math.min(writeArgs[2], 16 * 1024);
          return await write(...writeArgs);
        } finally { activeWrites--; }
      };
    } else if (destination && typeof args[1] === 'number' && file.toLowerCase().includes(`${path.sep}.putio-`)) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { if (activeWrites) readsDuringWrite++; return read(...readArgs); };
    }
    return handle;
  };
  const arm = () => { blocked = false; armed = true; gate = new Promise(resolve => { release = resolve; }); };
  try {
    const f = await withEngine(t, mode, {
      staging: true, stagingMaxBytes: size * 2, file: { size },
      secondFile: { size: chunk.length }, secondResponse: () => new Response(chunk),
      response: () => {
        let position = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (position >= size) { controller.close(); return; }
          const length = Math.min(chunk.length, size - position);
          if (activeWrites) producerDuringCopy++;
          controller.enqueue(chunk.subarray(0, length)); produced++; position += length;
        } }), { headers: { 'content-length': String(size), etag: '"fixture-v1"' } });
      },
    });
    destination = f.root;
    // Warm filesystem, engine and (for remote) HTTP paths before measuring.
    const warmup = await f.client.execute('downloadFile', ['2']);
    const warm = await waitFor(async () => {
      const value = (await f.client.getSnapshot()).jobs.find(j => j.id === warmup.jobId);
      return value && ['completed', 'failed', 'needs-attention'].includes(value.status) ? value : undefined;
    }, 'warmup');
    assert.equal(warm.status, 'completed', warm.error);
    writes = 0; maxWrites = 0; readsDuringWrite = 0;
    arm();
    global.gc?.(); baseline = process.memoryUsage().rss; peak = baseline;
    phase = 'download'; timer = setInterval(sample, 5);
    const { jobId } = await f.client.execute('downloadFile', ['1']);
    const job = async () => (await f.client.getSnapshot()).jobs.find(j => j.id === jobId);
    if (kind === 'stream') {
      await waitFor(() => blocked, 'blocked destination write');
      const before = produced; await sleep(30); assert.equal(produced, before); release();
    }
    if (kind === 'lifecycle') {
      for (let cycle = 0; cycle < 2; cycle++) {
        await waitFor(() => blocked, 'blocked destination write');
        const stopping = f.client.execute('pause'); release(); await stopping;
        assert.equal((await job()).status, 'paused');
        if (mode === 'remote') { await f.disconnectClient(); await f.reconnectClient(); }
        await f.restart();
        assert.equal((await job()).id, jobId);
        arm(); await f.client.execute('resume');
      }
      await waitFor(() => blocked, 'blocked write before cancel');
      const cancel = f.client.execute('cancelDownloads', [[jobId]]); release(); await cancel;
      assert.equal((await job()).status, 'canceled');
      await f.client.execute('retryDownload', [jobId]);
    }
    const done = await waitFor(async () => { const value = await job(); return value && ['completed', 'failed', 'needs-attention'].includes(value.status) ? value : undefined; }, 'completed copy');
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.id, jobId);
    phase = 'after-completion'; sample(); clearInterval(timer); timer = undefined;
    // Digest the published file after the engine measurement, using a separate bounded stream.
    assert.equal(await digest(path.join(f.root, 'file.bin')), expected);
    assert.equal(maxWrites, 1);
    assert.equal(readsDuringWrite, 0);
    assert.equal(producerDuringCopy, 0);
    assert.ok(writes > 0);
  } finally {
    if (timer) clearInterval(timer);
    release?.(); fs.open = originalOpen;
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
  process.stdout.write(JSON.stringify({ mode, kind, size, baseline, peak, delta: peak - baseline, maxWrites, readsDuringWrite, producerDuringCopy, produced, writes, maxima }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
