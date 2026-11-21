const {privateTemp}=require('./private-staging-fixture.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { copyArtifact, hashArtifact, createArtifactAnchor } = require('../../dist/core/staged-delivery.js');

async function main() {
  const size = Number(process.argv[2]);
  const root = await privateTemp(path.join(os.tmpdir(), 'putio-resource-'));
  const sourceName = '.putio-11111111-1111-4111-8111-111111111111.download';
  const sourcePath = path.join(root, sourceName);
  let timer;
  try {
    const file = await fs.open(sourcePath, 'wx');
    const expected = crypto.createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 17) % 256;
    let sourceOwner;
    try {
      sourceOwner = await createArtifactAnchor(root, sourceName, file);
      for (let position = 0; position < size;) {
        const length = Math.min(chunk.length, size - position);
        expected.update(chunk.subarray(0, length));
        let written = 0;
        while (written < length) {
          const result = await file.write(chunk, written, length - written, position + written);
          if (!result.bytesWritten) throw new Error('fixture write made no progress');
          written += result.bytesWritten;
        }
        position += length;
      }
    } finally { await file.close(); }
    const source = { root, name: sourceName, owned: sourceOwner };
    const evidence = { length: size, sha256: expected.digest('hex') };
    global.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const originalOpen = fs.open;
    let inFlight = 0, maxInFlight = 0, readsDuringWrite = 0, maxRead = 0, writes = 0;
    let instrument = true;
    fs.open = async function(filePath, flags, ...args) {
      const handle = await originalOpen.call(this, filePath, flags, ...args);
      if (instrument && String(filePath) === sourcePath && typeof flags === 'number') {
        const read = handle.read.bind(handle);
        handle.read = async (buffer, offset, length, position) => {
          if (inFlight) readsDuringWrite++;
          maxRead = Math.max(maxRead, length);
          return read(buffer, offset, length, position);
        };
      }
      if (instrument && flags === 'wx' && String(filePath) !== sourcePath) {
        const write = handle.write.bind(handle);
        handle.write = async (buffer, offset, length, position) => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); writes++;
          try {
            if (writes <= 4) await new Promise(resolve => setTimeout(resolve, 5));
            return await write(buffer, offset, Math.min(length, 16384), position);
          } finally { inFlight--; }
        };
      }
      return handle;
    };
    try {
      const target = { root, name: '.putio-22222222-2222-4222-8222-222222222222.download' };
      let owned;
      const identity = await copyArtifact(source, target, evidence, new AbortController().signal, async value => { owned = value; }, () => {});
      assert.deepEqual(identity, owned);
      assert.deepEqual(await hashArtifact({ ...target, owned }, new AbortController().signal), evidence);
      assert.equal(maxInFlight, 1);
      assert.equal(readsDuringWrite, 0);
      assert.ok(maxRead <= 64 * 1024 && maxRead > 0);
      assert.ok(writes > Math.ceil(size / (64 * 1024)), 'short writes were exercised');
      instrument = false;
      for (let i = 0; i < 6; i++) {
        const target = { root, name: `.putio-${String(i + 3).repeat(8)}-3333-4333-8333-333333333333.download` };
        const controller = new AbortController();
        await assert.rejects(copyArtifact(source, target, evidence, controller.signal,
          async () => { if (i % 2) throw new Error('synthetic persistence failure'); },
          () => controller.abort()));
        await fs.unlink(path.join(root, target.name));
      }
    } finally { fs.open = originalOpen; }
    peak = Math.max(peak, process.memoryUsage().rss);
    clearInterval(timer); timer = undefined;
    process.stdout.write(JSON.stringify({ size, baseline, peak, delta: peak - baseline, maxInFlight, readsDuringWrite, maxRead, writes }));
  } finally {
    if (timer) clearInterval(timer);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
