const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DownloadQueue } = require('../dist/core/downloads');
const { RuleScanner } = require('../dist/core/rules');
const { PutioApi } = require('../dist/core/api');
const { SettingsStore } = require('../dist/core/settings');

async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'putio-integration-'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, base: `http://127.0.0.1:${server.address().port}/` };
}

async function until(predicate, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function file(id, name, size = 4, parentId = '0', isFolder = false) {
  return { id, parentId, name, size, isFolder, contentType: '' };
}

function terminal(job) {
  return ['completed', 'failed', 'canceled', 'skipped'].includes(job.status);
}

test('queue bounds concurrency and cancels both active and queued work', async (t) => {
  let active = 0;
  let peak = 0;
  const requests = [];
  const { directory, base } = await fixture(t, (req, res) => {
    requests.push(req.url);
    active += 1;
    peak = Math.max(peak, active);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write('partial');
    const timer = setInterval(() => res.write('more'), 40);
    res.on('close', () => { clearInterval(timer); active -= 1; });
  });
  const queue = new DownloadQueue(() => 1, () => {});
  await queue.enqueue(file('one', 'one.bin'), directory, async () => `${base}one`);
  await queue.enqueue(file('two', 'two.bin'), directory, async () => `${base}two`);
  await until(() => requests.includes('/one'), 'first request');
  assert.equal(queue.jobs[1].status, 'queued');
  queue.cancel([queue.jobs[0].id, queue.jobs[1].id]);
  await until(() => queue.jobs.every(terminal), 'canceled jobs');
  assert.deepEqual(queue.jobs.map((job) => job.status), ['canceled', 'canceled']);
  assert.equal(peak, 1);
  assert.deepEqual(requests, ['/one']);
  await until(async () => (await fs.readdir(directory)).length === 0, 'temporary file removal');
  assert.deepEqual(await fs.readdir(directory), []);
});

test('successful bytes survive a destination collision and truncated streams never clean up remotely', async (t) => {
  const requests = [];
  const { directory, base } = await fixture(t, (req, res) => {
    requests.push(req.url);
    if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.writeHead(200, { 'Content-Length': '4' });
    res.end(req.url === '/first' ? 'good' : 'evil');
  });
  const cleaned = [];
  const queue = new DownloadQueue(() => 1, () => {});
  await queue.enqueue(file('first', 'same.bin'), directory, async () => `${base}first`, async () => cleaned.push('first'));
  await until(() => queue.jobs[0].status === 'completed' && cleaned.includes('first'), 'first download and cleanup');
  assert.equal(await fs.readFile(path.join(directory, 'same.bin'), 'utf8'), 'good');
  await queue.enqueue(file('second', 'same.bin'), directory, async () => `${base}second`, async () => cleaned.push('second'));
  await until(() => terminal(queue.jobs[1]), 'collision');
  assert.equal(queue.jobs[1].status, 'skipped');
  assert.equal(requests.includes('/second'), false);
  assert.equal(await fs.readFile(path.join(directory, 'same.bin'), 'utf8'), 'good');
  await queue.enqueue(file('third', 'partial.bin', 100), directory, async () => `${base}truncated`, async () => cleaned.push('third'));
  await until(() => terminal(queue.jobs[2]), 'truncated download');
  assert.equal(queue.jobs[2].status, 'failed');
  assert.deepEqual(cleaned, ['first']);
  await until(async () => (await fs.readdir(directory)).length === 1, 'partial file removal');
  assert.deepEqual(await fs.readdir(directory), ['same.bin']);
});

test('overlapping scans share one traversal and match exact extensions, size and nested paths', async (t) => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const entries = {
    '0': [
      { id: 1, parent_id: 0, name: 'nested', file_type: 'FOLDER', size: 0 },
      { id: 2, parent_id: 0, name: 'large.MP4', file_type: 'VIDEO', size: 100 },
      { id: 3, parent_id: 0, name: 'small.mp4', file_type: 'VIDEO', size: 9 },
      { id: 4, parent_id: 0, name: 'wrong.mp4x', file_type: 'VIDEO', size: 100 },
    ],
    '1': [{ id: 5, parent_id: 1, name: 'inside.mp4', file_type: 'VIDEO', size: 10 }],
  };
  const { directory, base } = await fixture(t, async (req, res) => {
    const url = new URL(req.url, base);
    const parent = url.searchParams.get('parent_id');
    calls.push(parent);
    if (parent === '0') await gate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', files: entries[parent] || [] }));
  });
  const api = new PutioApi(() => 'fixture-token', base);
  const queued = [];
  const scanner = new RuleScanner((id) => api.listFiles(id), async (item, target) => { queued.push([item.id, target]); });
  const rule = { id: 'r', folderId: '0', folderName: 'root', downloadDirectory: directory, extensions: ['.Mp4'], minSizeBytes: 10, keepFolderStructure: true };
  const first = scanner.scan([rule]);
  const second = scanner.scan([rule]);
  await until(() => calls.includes('0'), 'root listing');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['0', '1']);
  assert.deepEqual(queued, [['5', path.join(directory, 'nested')], ['2', directory]]);
});

test('settings and rules reload with encrypted credentials, while unavailable secure storage is session-only', async (t) => {
  const { directory } = await fixture(t, (_req, res) => res.end());
  const secure = {
    available: () => true,
    encrypt: (value) => Buffer.from(value.split('').reverse().join('')),
    decrypt: (value) => value.toString().split('').reverse().join(''),
  };
  const store = new SettingsStore(directory, secure);
  store.token = 'fixture-secret';
  store.settings.parallelDownloads = 3;
  store.rules = [{ id: 'rule', folderId: '1', folderName: 'folder', downloadDirectory: directory, extensions: ['mp4'], minSizeBytes: 10, keepFolderStructure: true }];
  await store.save();
  const disk = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.equal(disk.includes('fixture-secret'), false);
  const loaded = new SettingsStore(directory, secure);
  await loaded.load();
  assert.equal(loaded.token, 'fixture-secret');
  assert.equal(loaded.settings.parallelDownloads, 3);
  assert.deepEqual(loaded.rules, store.rules);
  const unavailable = { available: () => false, encrypt: () => { throw new Error('unexpected encryption'); }, decrypt: () => { throw new Error('unexpected decryption'); } };
  const sessionDir = path.join(directory, 'session');
  const session = new SettingsStore(sessionDir, unavailable);
  session.token = 'session-secret';
  await session.save();
  assert.equal(session.token, 'session-secret');
  assert.equal((await fs.readFile(path.join(sessionDir, 'settings.json'), 'utf8')).includes('session-secret'), false);
  const restarted = new SettingsStore(sessionDir, unavailable);
  await restarted.load();
  assert.equal(restarted.token, '');
});
