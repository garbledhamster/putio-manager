const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { storageStatus } = require('../dist/engine/storage');

test('storage capacity uses statfs metadata only and never lists or opens media', async t => {
  const sentinel = 'SENTINEL_PRIVATE_MOVIE_NAME_AND_PATH';
  const locations = [
    { id: 'download-1', kind: 'download', path: path.join(os.tmpdir(), sentinel, 'downloads') },
    { id: 'stage-1', kind: 'staging', path: path.join(os.tmpdir(), sentinel, 'staging') },
  ];
  const visited = [];
  t.mock.method(fs, 'statfs', async (location, options) => {
    visited.push(location);
    assert.deepEqual(options, { bigint: true });
    return { blocks: 100n, bsize: 4096n, bfree: 25n, bavail: 20n };
  });
  for (const method of ['readdir', 'opendir', 'readFile', 'open', 'lstat', 'stat', 'realpath', 'readlink']) {
    t.mock.method(fs, method, async () => { assert.fail('Storage analytics must not inspect files or directory contents'); });
  }
  const result = await storageStatus(locations);
  assert.deepEqual(visited, locations.map(location => location.path));
  assert.deepEqual(result, { volumes: locations.map(({ id, kind }) => ({
    id, kind, status: 'ok', capacityBytes: 409600, freeBytes: 102400, availableBytes: 81920,
  })) });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  for (const volume of result.volumes) assert.deepEqual(Object.keys(volume).sort(), [
    'availableBytes', 'capacityBytes', 'freeBytes', 'id', 'kind', 'status',
  ]);
});

test('unavailable storage capacity stays unknown and never becomes zero or a raw error', async t => {
  const sentinel = 'SENTINEL_PRIVATE_ERROR_ACCOUNT_TOKEN';
  t.mock.method(fs, 'statfs', async () => { throw Object.assign(new Error(sentinel), { path: sentinel, code: 'EACCES' }); });
  const result = await storageStatus([{ id: 'stage-1', kind: 'staging', path: path.join(os.tmpdir(), sentinel) }]);
  assert.deepEqual(result, { volumes: [{ id: 'stage-1', kind: 'staging', status: 'unavailable',
    capacityBytes: null, freeBytes: null, availableBytes: null,
  }] });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test('zero space is distinct from unavailable space and oversized measurements are unknown', async t => {
  let calls = 0;
  t.mock.method(fs, 'statfs', async () => ++calls === 1
    ? { blocks: 100n, bsize: 4096n, bfree: 0n, bavail: 0n }
    : { blocks: BigInt(Number.MAX_SAFE_INTEGER), bsize: 4096n, bfree: -1n, bavail: 1n });
  const result = await storageStatus([
    { id: 'full', kind: 'download', path: '/metadata/full' },
    { id: 'large', kind: 'staging', path: '/metadata/large' },
  ]);
  assert.equal(result.volumes[0].status, 'ok');
  assert.equal(result.volumes[0].freeBytes, 0);
  assert.equal(result.volumes[0].availableBytes, 0);
  assert.equal(result.volumes[1].capacityBytes, null);
  assert.equal(result.volumes[1].freeBytes, null);
  assert.equal(result.volumes[1].availableBytes, 4096);
});

test('actual disposable storage reports capacity without leaking the selected folder', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'putio-capacity-sentinel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await storageStatus([{ id: 'disposable', kind: 'download', path: dir }]);
  const volume = result.volumes[0];
  assert.equal(volume.status, 'ok');
  assert.ok(volume.capacityBytes > 0);
  assert.ok(volume.freeBytes >= 0);
  assert.ok(volume.availableBytes >= 0);
  assert.equal(JSON.stringify(result).includes(JSON.stringify(dir).slice(1, -1)), false);
});
