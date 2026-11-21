const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const child = path.join(__dirname, 'helpers', 'staged-delivery-engine-resource-child.cjs');
async function measure(mode, kind, size) {
  const result = await run(process.execPath, ['--expose-gc', child, mode, kind, String(size)], { timeout: 110000, maxBuffer: 1024 * 1024, windowsHide: true });
  return JSON.parse(result.stdout);
}
for (const mode of ['local', 'remote']) {
  test(`${mode} staged engine streams within bounded RSS and copy backpressure`, { timeout: 240000 }, async () => {
    const small = await measure(mode, 'stream', 2 * 1024 * 1024);
    const large = await measure(mode, 'stream', 96 * 1024 * 1024);
    // Concurrent copies are one. Allow 32 MiB additional peak RSS for runtime and HTTP variability.
    assert.ok(large.delta - small.delta <= 32 * 1024 * 1024,
      `RSS growth exceeds 32 MiB: small=${small.delta}, large=${large.delta}`);
  });
  test(`${mode} staged engine settles repeated pause, restart, cancel and retry`, { timeout: 120000 }, async () => {
    await measure(mode, 'lifecycle', 2 * 1024 * 1024);
  });
}
