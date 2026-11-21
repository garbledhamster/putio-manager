const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const child = path.join(__dirname, 'helpers', 'staged-delivery-resource-child.cjs');

test('copy uses bounded memory and settles after short writes, aborts and errors', { timeout: 120000 }, async () => {
  async function measure(size) {
    const result = await run(process.execPath, ['--expose-gc', child, String(size)], { timeout: 55000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  }
  const small = await measure(2 * 1024 * 1024);
  const large = await measure(96 * 1024 * 1024);
  // Predeclared tolerance: no more than 32 MiB extra peak RSS above baseline.
  assert.ok(large.delta - small.delta <= 32 * 1024 * 1024,
    `RSS growth exceeds 32 MiB: small=${small.delta}, large=${large.delta}`);
  assert.equal(large.maxInFlight, 1);
  assert.equal(large.readsDuringWrite, 0);
});
