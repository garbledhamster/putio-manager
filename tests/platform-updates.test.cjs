const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
function adapterFactory() {
  return require('../dist/desktop/platform-updates.js').createNativeUpdateAdapter;
}
async function fixture(t, platform) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-updater-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const context = { platform, arch: 'x64', currentVersion: '2.1.0', isPackaged: true, resourcesDirectory: path.join(dir, 'resources'), applicationDirectory: path.join(dir, 'PutioManager.app'), executablePath: path.join(dir, 'app'), userDataDirectory: path.join(dir, 'profile'), quitApplication() { context.quit = true; } };
  const bytes = Buffer.from('generated updater fixture');
  const name = platform === 'darwin' ? 'PutioManager-2.2.0-macos-x64-update.zip' : 'PutioManager-2.2.0-linux-x64.AppImage';
  const asset = { name, url: `https://github.com/garbledhamster/putio-manager/releases/download/v2.2.0/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (platform === 'darwin') asset.ed25519 = Buffer.alloc(64, 1).toString('base64');
  return { dir, context, bytes, release: { version: '2.2.0', platform: platform === 'darwin' ? 'macos' : 'linux', arch: 'x64', asset, assets: [asset] } };
}
function linuxDependencies(bytes, overrides = {}) {
  return {
    fetcher: async () => new Response(bytes), syncDirectory: async () => {},
    spawn: (executable, args) => {
      assert.equal(executable, '/bin/sh'); assert.equal(args[3], String(process.pid)); assert.ok(args[1].includes('exec "$2" --enable-sandbox'));
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
      queueMicrotask(() => child.stdout.write('ready\n')); return child;
    }, ...overrides,
  };
}
test('native adapter rejects unsupported and unpackaged installations without work', async t => {
  const f = await fixture(t, 'linux');
  const adapter = adapterFactory()({ ...f.context, isPackaged: false });
  assert.equal(adapter.supported, false);
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /unsupported-installation/);
});
test('Linux verifies exact downloaded bytes before a separately authorized handoff', async t => {
  const f = await fixture(t, 'linux');
  const image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(f.context.quit, undefined);
  await assert.rejects(adapter.handoff({ ...prepared, id: 'forged' }), /installer-failed/);
  await adapter.handoff(prepared); assert.deepEqual(await fs.readFile(image), f.bytes); assert.equal(f.context.quit, true);
  await assert.rejects(adapter.handoff(prepared), /installer-failed/);
});
test('Linux hash mismatch and wrong release cannot install', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies('bad'), environment: { APPIMAGE: image } });
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /download-invalid/);
  await assert.rejects(adapter.prepare({ ...f.release, arch: 'arm64' }, new AbortController().signal, () => {}), /release-invalid/);
});
test('Mac preparation waits for verified-ready and does not send install early', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
  let commands = ''; child.stdin.on('data', chunk => { commands += chunk; if (commands === 'install\n') queueMicrotask(() => child.emit('exit', 0)); });
  let spawnOptions;
  const adapter = adapterFactory()(f.context, { spawn: (_exe, args, options) => { spawnOptions = options; assert.equal(args[args.indexOf('--feed-url') + 1], 'https://github.com/garbledhamster/putio-manager/releases/download/v2.2.0/appcast-x64.xml'); queueMicrotask(() => { child.stdout.write(JSON.stringify({ schema: 1, phase: 'available', version: '2.2.0' }) + '\n'); child.stdout.write(JSON.stringify({ schema: 1, phase: 'ready' }) + '\n'); }); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  assert.equal(commands, ''); assert.equal(f.context.quit, undefined); assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.env.PUTIO_UPDATER_EXPECTED_SIGNATURE, f.release.asset.ed25519);
  assert.equal(spawnOptions.env.PUTIO_UPDATER_EXPECTED_BYTES, String(f.bytes.length));
  await adapter.handoff(prepared); assert.equal(commands, 'install\n');
});
test('Mac cannot start a helper without its canonical signed archive binding', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  let calls = 0;
  const adapter = adapterFactory()(f.context, { spawn: () => { calls++; throw Error('must not start'); } });
  for (const ed25519 of [undefined, 'invalid', Buffer.alloc(63).toString('base64')]) {
    await assert.rejects(adapter.prepare({ ...f.release, asset: { ...f.release.asset, ed25519 } }, new AbortController().signal, () => {}), /release-invalid/);
  }
  assert.equal(calls, 0);
});
test('Mac malformed, wrong-version and signature-failure events never grant handoff', async t => {
  for (const [event, code] of [
    ['raw private path /fixture/credential', 'release-invalid'],
    [JSON.stringify({ schema: 1, phase: 'available', version: '9.9.9' }), 'release-invalid'],
    [JSON.stringify({ schema: 1, phase: 'ready' }), 'release-invalid'],
    [JSON.stringify({ schema: 1, phase: 'failed', code: 'signature-invalid', detail: '/private/fixture' }), 'signature-invalid'],
    [JSON.stringify({ schema: 1, phase: 'failed', code: 'release-invalid' }), 'release-invalid'],
    [JSON.stringify({ schema: 1, phase: 'failed', code: 'download-invalid' }), 'download-invalid'],
  ]) {
    const f = await fixture(t, 'darwin');
    const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
    await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1);
    const adapter = adapterFactory()(f.context, { spawn: () => { queueMicrotask(() => child.stdout.write(event + '\n')); return child; } });
    await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), error => error.message === code && !error.message.includes('/fixture'));
    await assert.rejects(adapter.handoff({ version: '2.2.0', id: 'forged' }), /installer-failed/);
  }
});
test('Mac cancellation after READY sends cancellation and invalidates the install token', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1);
  let commands = ''; child.stdin.on('data', chunk => { commands += chunk; if (commands === 'cancel\n') queueMicrotask(() => child.emit('exit', 0)); });
  const adapter = adapterFactory()(f.context, { spawn: () => { queueMicrotask(() => child.stdout.write('{"schema":1,"phase":"available","version":"2.2.0"}\n{"schema":1,"phase":"ready"}\n')); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await adapter.cancel(); assert.equal(commands, 'cancel\n');
  await assert.rejects(adapter.handoff(prepared), /installer-failed/);
});
test('Mac authorization failure after the install gate returns a controlled failure', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
  child.stdin.on('data', () => queueMicrotask(() => { child.stderr.write('private fixture /credential/path'); child.stdout.write('{"schema":1,"phase":"failed","code":"permission-required"}\n'); child.emit('exit', 8); }));
  const adapter = adapterFactory()(f.context, { spawn: () => { queueMicrotask(() => child.stdout.write('{"schema":1,"phase":"available","version":"2.2.0"}\n{"schema":1,"phase":"ready"}\n')); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'permission-required');
});
test('already-cancelled Linux preparation does not create or invoke an updater', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'generated');
  let invoked = false;
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image }, fetcher: async () => { invoked = true; throw Error('must not run'); } });
  await assert.rejects(adapter.prepare(f.release, AbortSignal.abort(), () => {}), /installer-cancelled/); assert.equal(invoked, false);
});
test('Mac READY followed by exit in the same microtask cannot mint an install token', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
  let commands = ''; child.stdin.on('data', chunk => commands += chunk);
  const adapter = adapterFactory()(f.context, { spawn: () => { queueMicrotask(() => { child.stdout.write('{"schema":1,"phase":"available","version":"2.2.0"}\n{"schema":1,"phase":"ready"}\n'); child.emit('exit', 1); }); return child; } });
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), error => error.message === 'installer-failed');
  assert.equal(commands, '');
});
test('Mac exit after preparation rejects handoff promptly without writing install', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
  let commands = ''; child.stdin.on('data', chunk => commands += chunk);
  const adapter = adapterFactory()(f.context, { spawn: () => { queueMicrotask(() => child.stdout.write('{"schema":1,"phase":"available","version":"2.2.0"}\n{"schema":1,"phase":"ready"}\n')); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  child.emit('exit', 1);
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'installer-failed'); assert.equal(commands, '');
});
test('Mac handoff has a deadline when a helper never exits', async t => {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
  const adapter = adapterFactory()(f.context, { handoffTimeoutMs: 20, spawn: () => { queueMicrotask(() => child.stdout.write('{"schema":1,"phase":"available","version":"2.2.0"}\n{"schema":1,"phase":"ready"}\n')); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'restart-required');
  child.emit('exit', 0);
});
test('a definite Linux transfer failure permits a fresh preparation', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  let attempts = 0;
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image }, fetcher: async () => { attempts++; return new Response(f.bytes); }, rename: async () => { throw Error('private fixture diagnostic'); } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'installer-failed');
  assert.equal(await fs.readFile(image, 'utf8'), 'old');
  await adapter.cancel();
  const next = await adapter.prepare(f.release, new AbortController().signal, () => {});
  assert.equal(attempts, 2); assert.notEqual(next.id, prepared.id);
});
test('Linux only requests its authenticated asset and rejects foreign redirects and excess bytes', async t => {
  for (const [response, code] of [[() => new Response('', { status: 302, headers: { location: 'https://foreign.invalid/private' } }), 'release-invalid'], [bytes => new Response(Buffer.concat([bytes, Buffer.from('overflow')])), 'download-invalid']]) {
    const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
    const requests = [];
    const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image }, fetcher: async url => { requests.push(url); return response(f.bytes); } });
    await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), error => error.message === code);
    assert.deepEqual(requests, [f.release.asset.url]); assert.equal(await fs.readFile(image, 'utf8'), 'old');
    assert.equal(f.context.quit, undefined);
  }
});
test('Linux READY acknowledgement followed by waiter exit cannot replace the current image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image }, spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('exit', 1); child.unref = () => {};
    queueMicrotask(() => { child.stdout.write('ready\n'); child.emit('exit', 1); }); return child;
  } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'installer-failed');
  assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(f.context.quit, undefined);
});
test('Linux rejects changed original or staged file identities before replacement', async t => {
  for (const target of ['original', 'stage']) {
    const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
    const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image } });
    const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
    const stage = (await fs.readdir(f.dir)).find(name => name.startsWith('.putio-update-'));
    await fs.writeFile(target === 'original' ? image : path.join(f.dir, stage), 'changed fixture');
    await assert.rejects(adapter.handoff(prepared), error => ['installer-failed', 'download-invalid'].includes(error.message));
    assert.equal(await fs.readFile(image, 'utf8'), target === 'original' ? 'changed fixture' : 'old'); assert.equal(f.context.quit, undefined);
  }
});
test('Linux relaunch acknowledgement timeout preserves the current image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image }, handoffTimeoutMs: 20, spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('exit', 1); return child;
  } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'installer-failed');
  assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(f.context.quit, undefined);
});
test('Linux post-commit failure reports restart required and retains the complete new image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  let syncs = 0;
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image }, syncDirectory: async () => { if (++syncs === 2) throw Error('generated post-rename failure'); } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'restart-required');
  assert.deepEqual(await fs.readFile(image), f.bytes); assert.equal(f.context.quit, undefined);
});
test('Linux cancellation removes only the owned staging image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await adapter.cancel();
  assert.equal((await fs.readdir(f.dir)).filter(name => name.startsWith('.putio-update-')).length, 0); assert.equal(await fs.readFile(image, 'utf8'), 'old');
  await assert.rejects(adapter.handoff(prepared), /installer-failed/);
});
