const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { applyWindowsUpdate, validateWindowsUpdateJob, windowsInstallerResult } = require('../dist/desktop/update-windows-helper.js');
const { createWindowsUpdateAdapter, readWindowsUpdateOutcome } = require('../dist/desktop/windows-updates.js');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const privateCanary = 'GENERATED_PRIVATE_PROFILE_CANARY';

async function temporaryDirectory(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-updater-unit-'));
  t.after(async () => {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('windows-updater-unit-')) throw Error('Unexpected fixture cleanup boundary.');
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return fs.realpath(temporary);
}

async function helperFixture(t) {
  const root = await temporaryDirectory(t);
  const profile = path.join(root, privateCanary);
  const directory = path.join(profile, 'desktop-updates', 'windows-generated');
  const installDirectory = path.join(root, 'installed', 'PutioManager');
  const previousExecutable = path.join(root, 'previous', 'PutioManager.exe');
  const installer = path.join(directory, 'verified-update.msi');
  const payload = Buffer.from('Generated MSI bytes; never execute this fixture.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.mkdir(installDirectory, { recursive: true });
  await fs.mkdir(path.dirname(previousExecutable), { recursive: true });
  await fs.writeFile(installer, payload);
  await fs.writeFile(previousExecutable, 'Generated previous application; never execute.');
  await fs.writeFile(path.join(installDirectory, 'PutioManager.exe'), 'Generated next application; never execute.');
  const job = { schema: 1, targetVersion: '2.3.0', currentVersion: '2.2.0', arch: 'x64', parentPid: process.pid, bytes: payload.length, sha256: digest(payload), installDirectory, previousExecutable };
  const jobFile = path.join(directory, 'handoff.json');
  await fs.writeFile(jobFile, JSON.stringify(job));
  const calls = [];
  const dependencies = {
    platform: 'win32',
    ready() { calls.push('ready'); },
    async waitParent(pid) { assert.equal(pid, job.parentPid); calls.push('parent-exited'); },
    async install(filename, received) { assert.equal(filename, installer); assert.equal(received.targetVersion, job.targetVersion); calls.push('install'); return 0; },
    async registry(arch, name) {
      assert.equal(arch, job.arch);
      return { InstalledVersion: job.targetVersion, InstallLocation: installDirectory, ProductCode: '{11111111-2222-3333-4444-555555555555}' }[name];
    },
    async verifyVersion(filename) { assert.equal(filename, path.join(installDirectory, 'PutioManager.exe')); calls.push('verify-version'); return job.targetVersion; },
    relaunch(filename) { calls.push(filename === previousExecutable ? 'relaunch-previous' : 'relaunch-updated'); },
  };
  return { root, profile, directory, installer, payload, job, jobFile, calls, dependencies };
}

test('Windows handoff jobs allow only newer bounded versions, known architectures and absolute application paths', async t => {
  const f = await helperFixture(t);
  assert.deepEqual(validateWindowsUpdateJob({ ...f.job, private: privateCanary }), f.job);
  for (const patch of [
    { schema: 2 }, { targetVersion: '2.3.0-beta' }, { currentVersion: '256.0.0' }, { targetVersion: '2.2.0' }, { targetVersion: '2.1.99' },
    { arch: 'ia32' }, { parentPid: 0 }, { parentPid: 1.5 }, { bytes: 0 }, { bytes: 2 * 1024 ** 3 + 1 }, { sha256: 'not a digest' },
    { installDirectory: 'relative/PutioManager' }, { installDirectory: path.join(f.root, 'DifferentApp') },
    { previousExecutable: 'relative/PutioManager.exe' }, { previousExecutable: path.join(f.root, 'DifferentApp.exe') },
  ]) assert.throws(() => validateWindowsUpdateJob({ ...f.job, ...patch }), error => ['download-invalid', 'release-invalid'].includes(error.message));
});

test('Windows success requires parent exit, installer success, matching registry and actual executable version', async t => {
  const f = await helperFixture(t);
  const receipt = await applyWindowsUpdate(f.jobFile, f.dependencies);
  assert.equal(receipt.phase, 'updated');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.version, f.job.targetVersion);
  assert.deepEqual(f.calls, ['ready', 'parent-exited', 'install', 'verify-version', 'relaunch-updated']);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'receipt.json'), 'utf8'));
  assert.deepEqual(saved, receipt);
  assert.ok(!JSON.stringify(receipt).includes(privateCanary));
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  assert.equal(await readWindowsUpdateOutcome(f.profile, '2.2.0'), undefined);
});

for (const [code, expected] of [[3010, 'restart-required'], [1641, 'restart-required'], [1618, 'installer-busy'], [1602, 'installer-cancelled'], [1603, 'installer-failed']]) {
  test(`Windows Installer result ${code} retains its controlled outcome without claiming verified success`, async t => {
    const f = await helperFixture(t);
    f.dependencies.install = async () => { f.calls.push('install'); return code; };
    assert.equal(windowsInstallerResult(code), expected);
    const receipt = await applyWindowsUpdate(f.jobFile, f.dependencies);
    assert.equal(receipt.phase, expected === 'restart-required' ? 'restart-required' : 'failed');
    assert.equal(receipt.errorCode, expected);
    assert.equal(receipt.verified, false);
    assert.ok(!f.calls.includes('verify-version'));
    assert.ok(!f.calls.includes('relaunch-updated'));
    assert.equal(f.calls.includes('relaunch-previous'), expected !== 'restart-required');
    assert.deepEqual(await readWindowsUpdateOutcome(f.profile, f.job.currentVersion), { phase: receipt.phase, errorCode: expected });
  });
}

test('Windows helper never invokes an installer while parent exit is unconfirmed', async t => {
  const f = await helperFixture(t);
  f.dependencies.waitParent = async () => { throw Error('app-busy'); };
  const receipt = await applyWindowsUpdate(f.jobFile, f.dependencies);
  assert.equal(receipt.errorCode, 'app-busy');
  assert.equal(receipt.verified, false);
  assert.ok(!f.calls.includes('install'));
});

test('Windows helper validates its input path and refuses a second application of the same handoff', async t => {
  const f = await helperFixture(t);
  await assert.rejects(applyWindowsUpdate('handoff.json', f.dependencies), /unsupported-installation/);
  await assert.rejects(applyWindowsUpdate(path.join(f.directory, 'different.json'), f.dependencies), /unsupported-installation/);
  await assert.rejects(applyWindowsUpdate(f.jobFile, { ...f.dependencies, platform: 'linux' }), /unsupported-installation/);
  await applyWindowsUpdate(f.jobFile, f.dependencies);
  await assert.rejects(applyWindowsUpdate(f.jobFile, f.dependencies));
  assert.equal(f.calls.filter(value => value === 'install').length, 1);
});

for (const when of ['before-ready', 'after-parent-exit']) {
  test(`Windows helper rechecks installer identity ${when} and refuses altered bytes`, async t => {
    const f = await helperFixture(t);
    const tamper = () => fs.writeFile(f.installer, Buffer.alloc(f.payload.length, 1));
    if (when === 'before-ready') await tamper();
    else f.dependencies.waitParent = tamper;
    const receipt = await applyWindowsUpdate(f.jobFile, f.dependencies);
    assert.equal(receipt.errorCode, 'download-invalid');
    assert.equal(receipt.verified, false);
    assert.ok(!f.calls.includes('install'));
    if (when === 'before-ready') assert.ok(!f.calls.includes('ready'));
  });
}

for (const mismatch of ['registry-version', 'registry-location', 'registry-product', 'executable-version']) {
  test(`Windows success code cannot hide a mismatched ${mismatch}`, async t => {
    const f = await helperFixture(t);
    const registry = f.dependencies.registry;
    f.dependencies.registry = async (arch, name) => {
      if (mismatch === 'registry-version' && name === 'InstalledVersion') return '2.2.0';
      if (mismatch === 'registry-location' && name === 'InstallLocation') return path.join(f.root, 'other', 'PutioManager');
      if (mismatch === 'registry-product' && name === 'ProductCode') return 'invalid product code';
      return registry(arch, name);
    };
    if (mismatch === 'executable-version') f.dependencies.verifyVersion = async () => '2.2.0';
    const receipt = await applyWindowsUpdate(f.jobFile, f.dependencies);
    assert.equal(receipt.phase, 'failed');
    assert.equal(receipt.errorCode, 'installer-failed');
    assert.equal(receipt.verified, false);
    assert.ok(f.calls.includes('relaunch-previous'));
    assert.ok(!f.calls.includes('relaunch-updated'));
  });
}

test('Windows helper receipts suppress unexpected native diagnostics and private fixture paths', async t => {
  const f = await helperFixture(t);
  f.dependencies.install = async () => { throw Error(`${privateCanary}: private native diagnostic`); };
  const receipt = await applyWindowsUpdate(f.jobFile, f.dependencies);
  assert.equal(receipt.errorCode, 'installer-failed');
  const saved = await fs.readFile(path.join(f.directory, 'receipt.json'), 'utf8');
  assert.ok(!saved.includes(privateCanary));
  assert.ok(!saved.includes(f.root));
  assert.ok(!saved.includes('native diagnostic'));
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.2.0'), { phase: 'failed', errorCode: 'installer-failed' });
});

async function adapterFixture(t) {
  const root = await temporaryDirectory(t);
  const context = { platform: 'win32', arch: 'x64', currentVersion: '2.2.0', isPackaged: true, resourcesDirectory: path.join(root, 'resources'), applicationDirectory: root, executablePath: path.join(root, 'PutioManager.exe'), userDataDirectory: path.join(root, privateCanary), quitApplication() { throw Error('A generated unit fixture must never quit an application.'); } };
  const payload = Buffer.from('Generated adapter MSI; never execute.');
  const asset = { name: 'PutioManager-2.3.0-windows-x64-setup.msi', url: 'https://github.com/garbledhamster/putio-manager/releases/download/v2.3.0/PutioManager-2.3.0-windows-x64-setup.msi', bytes: payload.length, sha256: digest(payload) };
  const release = { version: '2.3.0', platform: 'windows', arch: 'x64', asset, assets: [asset] };
  await fs.mkdir(path.join(context.resourcesDirectory, 'update-runtime'), { recursive: true });
  await fs.writeFile(path.join(context.resourcesDirectory, 'update-runtime', 'node.exe'), 'Generated runtime; never execute.');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, asset.url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    return new Response(payload, { headers: { 'content-length': String(payload.length) } });
  });
  return { root, context, payload, release, adapter: createWindowsUpdateAdapter(context) };
}

test('Windows adapter rejects unsupported copies and wrong platform, architecture or asset before preparation', async t => {
  const f = await adapterFixture(t);
  const unsupported = createWindowsUpdateAdapter({ ...f.context, isPackaged: false });
  assert.equal(unsupported.supported, false);
  await assert.rejects(unsupported.prepare(f.release, new AbortController().signal, () => {}), error => error.updateCode === 'unsupported-installation');
  for (const patch of [{ platform: 'linux' }, { arch: 'arm64' }, { asset: { ...f.release.asset, name: '../untrusted.msi' } }]) {
    await assert.rejects(f.adapter.prepare({ ...f.release, ...patch }, new AbortController().signal, () => {}), error => error.updateCode === 'release-invalid');
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('Windows adapter owns opaque one-use preparation, cancel cleanup and a fresh retry', async t => {
  const f = await adapterFixture(t);
  const progress = [];
  const prepared = await f.adapter.prepare(f.release, new AbortController().signal, value => progress.push(value));
  assert.equal(prepared.version, f.release.version);
  assert.ok(prepared.id && !prepared.id.includes(f.root));
  assert.equal(progress.at(-1).phase, 'ready');
  await assert.rejects(f.adapter.prepare(f.release, new AbortController().signal, () => {}), error => error.updateCode === 'app-busy');
  await assert.rejects(f.adapter.handoff({ ...prepared, id: 'forged' }), error => error.updateCode === 'download-invalid');
  await assert.rejects(f.adapter.handoff({ ...prepared, version: '9.0.0' }), error => error.updateCode === 'download-invalid');
  await f.adapter.cancel();
  assert.deepEqual(await fs.readdir(path.join(f.context.userDataDirectory, 'desktop-updates')), []);
  await assert.rejects(f.adapter.handoff(prepared), error => error.updateCode === 'download-invalid');
  const retry = await f.adapter.prepare(f.release, new AbortController().signal, () => {});
  assert.notEqual(retry.id, prepared.id);
  await f.adapter.cancel();
  await f.adapter.cancel();
});

test('Windows adapter catches modified cached MSI before any registry query or helper spawn', async t => {
  const f = await adapterFixture(t);
  const prepared = await f.adapter.prepare(f.release, new AbortController().signal, () => {});
  const cache = path.join(f.context.userDataDirectory, 'desktop-updates');
  const directories = await fs.readdir(cache);
  await fs.writeFile(path.join(cache, directories[0], 'verified-update.msi'), Buffer.alloc(f.payload.length, 1));
  await assert.rejects(f.adapter.handoff(prepared), error => error.updateCode === 'download-invalid');
  await f.adapter.cancel();
});

test('Windows outcome rejects malformed, unverified and foreign error receipts without disclosing contents', async t => {
  const f = await helperFixture(t);
  const receiptFile = path.join(f.directory, 'receipt.json');
  for (const receipt of [
    'not JSON',
    JSON.stringify({ schema: 9, phase: 'failed', errorCode: 'installer-failed' }),
    JSON.stringify({ schema: 1, phase: 'updated', version: '2.3.0', verified: false }),
    JSON.stringify({ schema: 1, phase: 'failed', errorCode: privateCanary }),
  ]) {
    await fs.writeFile(receiptFile, receipt);
    assert.equal(await readWindowsUpdateOutcome(f.profile, '2.3.0'), undefined);
  }
});

test('Windows outcome retires a failure from an older target after a newer manual installation', async t => {
  const f = await helperFixture(t);
  await fs.writeFile(path.join(f.directory, 'receipt.json'), JSON.stringify({ schema: 1, version: '2.3.0', phase: 'failed', errorCode: 'installer-failed', verified: false }));
  assert.equal(await readWindowsUpdateOutcome(f.profile, '2.4.0'), undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'receipt.json'), 'utf8')).phase, 'failed');
});

test('Windows terminal receipt releases only owned heavy cache files and preserves recovery records', async t => {
  const f = await helperFixture(t);
  await applyWindowsUpdate(f.jobFile, f.dependencies);
  for (const name of ['node.exe', 'apply-update.js', 'unknown-fixture.txt']) await fs.writeFile(path.join(f.directory, name), 'Generated cache fixture.');
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['handoff.json', 'handoff.lock', 'receipt.json', 'unknown-fixture.txt']);
});

test('Windows failed terminal receipt also releases its verified download for a fresh retry', async t => {
  const f = await helperFixture(t);
  f.dependencies.install = async () => 1603;
  await applyWindowsUpdate(f.jobFile, f.dependencies);
  await fs.writeFile(path.join(f.directory, 'node.exe'), 'Generated unused runtime.');
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.2.0'), { phase: 'failed', errorCode: 'installer-failed' });
  await assert.rejects(fs.lstat(f.installer), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(f.directory, 'node.exe')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(f.jobFile, 'utf8')).targetVersion, '2.3.0');
});

test('Windows cleanup retries a mapped runtime on the next launch without removing recovery records', async t => {
  const f = await helperFixture(t);
  await applyWindowsUpdate(f.jobFile, f.dependencies);
  const runtime = path.join(f.directory, 'node.exe');
  await fs.writeFile(runtime, 'Generated mapped runtime.');
  const unlink = fs.unlink;
  let locked = true;
  t.mock.method(fs, 'unlink', async filename => {
    if (filename === runtime && locked) { locked = false; throw Object.assign(Error('Generated file sharing violation.'), { code: 'EBUSY' }); }
    return unlink(filename);
  });
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  assert.equal((await fs.lstat(runtime)).isFile(), true);
  assert.equal((await fs.lstat(f.jobFile)).isFile(), true);
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  await assert.rejects(fs.lstat(runtime), { code: 'ENOENT' });
  assert.equal((await fs.lstat(path.join(f.directory, 'receipt.json'))).isFile(), true);
});

test('Windows cleanup leaves an in-progress or unproven operation intact', async t => {
  const f = await helperFixture(t);
  await fs.writeFile(path.join(f.directory, 'handoff.lock'), '');
  await fs.writeFile(path.join(f.directory, 'receipt.json'), JSON.stringify({ schema: 1, version: '2.3.0', phase: 'installing', verified: false }));
  assert.equal(await readWindowsUpdateOutcome(f.profile, '2.3.0'), undefined);
  assert.equal((await fs.lstat(f.installer)).size, f.payload.length);
  await fs.writeFile(path.join(f.directory, 'receipt.json'), JSON.stringify({ schema: 1, version: '2.3.0', phase: 'updated', verified: true }));
  await fs.writeFile(f.jobFile, JSON.stringify({ ...f.job, targetVersion: '2.4.0' }));
  await readWindowsUpdateOutcome(f.profile, '2.3.0');
  assert.equal((await fs.lstat(f.installer)).size, f.payload.length);
});

test('Windows completed reboot retires the restart warning while retaining authoritative current version and records', async t => {
  const f = await helperFixture(t);
  f.dependencies.install = async () => 3010;
  await applyWindowsUpdate(f.jobFile, f.dependencies);
  const receiptFile = path.join(f.directory, 'receipt.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.bootTime = Date.now() - os.uptime() * 1000 - 300000;
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  assert.equal(JSON.parse(await fs.readFile(receiptFile, 'utf8')).phase, 'restart-required');
  assert.equal(await readWindowsUpdateOutcome(f.profile, '2.2.0'), undefined);
});

test('Windows receipt selection finds the newest terminal outcome beyond sixty-four operation directories', async t => {
  const f = await helperFixture(t);
  const root = path.dirname(f.directory);
  const older = new Date(Date.now() - 60000);
  for (let index = 0; index < 66; index++) {
    const directory = path.join(root, `windows-a${String(index).padStart(3, '0')}`);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'handoff.json'), JSON.stringify(f.job));
    await fs.writeFile(path.join(directory, 'handoff.lock'), '');
    await fs.writeFile(path.join(directory, 'verified-update.msi'), f.payload);
    const receipt = path.join(directory, 'receipt.json');
    await fs.writeFile(receipt, JSON.stringify({ schema: 1, version: '2.3.0', phase: 'failed', errorCode: 'installer-failed', verified: false }));
    await fs.utimes(receipt, older, older);
  }
  const latest = path.join(root, 'windows-zNewest');
  await fs.mkdir(latest);
  await fs.writeFile(path.join(latest, 'receipt.json'), JSON.stringify({ schema: 1, version: '2.3.0', phase: 'updated', verified: true }));
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  for (const name of ['windows-a000', 'windows-a065']) await assert.rejects(fs.lstat(path.join(root, name, 'verified-update.msi')), { code: 'ENOENT' });
});

test('Windows cleanup never traverses a linked operation directory or a linked heavy-file name', async t => {
  const f = await helperFixture(t);
  await applyWindowsUpdate(f.jobFile, f.dependencies);
  const outside = path.join(f.root, 'outside-operation');
  await fs.rename(f.directory, outside);
  await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await readWindowsUpdateOutcome(f.profile, '2.3.0'), undefined);
  assert.equal((await fs.lstat(path.join(outside, 'verified-update.msi'))).size, f.payload.length);
  await fs.unlink(f.directory);
  await fs.rename(outside, f.directory);
  const unknown = path.join(f.root, 'outside-content');
  await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, 'sentinel'), 'Generated data must remain.');
  await fs.symlink(unknown, path.join(f.directory, 'node.exe'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await readWindowsUpdateOutcome(f.profile, '2.3.0'), { phase: 'updated' });
  assert.equal(await fs.readFile(path.join(unknown, 'sentinel'), 'utf8'), 'Generated data must remain.');
  assert.equal((await fs.lstat(path.join(f.directory, 'node.exe'))).isSymbolicLink(), true);
});
