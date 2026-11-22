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
test('native Mac and Linux execution guards require the exact disposable hosted runner', async () => {
  const { assertHostedNativeFixture } = await import('../scripts/macos-updater/native-fixture.mjs');
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'garbledhamster/putio-manager', RUNNER_TEMP: 'generated-fixture-temp' };
  for (const platform of ['darwin', 'linux']) {
    assert.doesNotThrow(() => assertHostedNativeFixture(platform, platform, env));
    assert.throws(() => assertHostedNativeFixture(platform, 'win32', env), /restricted/);
    for (const change of [{ CI: 'false' }, { GITHUB_ACTIONS: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'generated/other-project' }, { RUNNER_TEMP: '' }]) assert.throws(() => assertHostedNativeFixture(platform, platform, { ...env, ...change }), /restricted/);
    assert.throws(() => assertHostedNativeFixture(platform, platform, { CI: 'true' }), /restricted/);
  }
  assert.throws(() => assertHostedNativeFixture('win32', 'win32', env), /restricted/);
});
async function fixture(t, platform) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-updater-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const context = { platform, arch: 'x64', currentVersion: '2.1.0', isPackaged: true, resourcesDirectory: path.join(dir, 'resources'), applicationDirectory: path.join(dir, 'PutioManager.app'), executablePath: path.join(dir, 'app'), userDataDirectory: path.join(dir, 'profile'), quitApplication() { context.quit = true; } };
  const appDir = path.join(dir, 'AppDir');
  if (platform === 'linux') {
    context.applicationDirectory = appDir; context.resourcesDirectory = path.join(appDir, 'resources'); context.executablePath = path.join(appDir, 'PutioManager');
    await fs.mkdir(context.resourcesDirectory, { recursive: true }); await fs.writeFile(context.executablePath, 'generated executable');
  }
  const bytes = Buffer.from('generated updater fixture');
  const name = platform === 'darwin' ? 'PutioManager-2.2.0-macos-x64-update.zip' : 'PutioManager-2.2.0-linux-x64.AppImage';
  const asset = { name, url: `https://github.com/garbledhamster/putio-manager/releases/download/v2.2.0/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (platform === 'darwin') asset.ed25519 = Buffer.alloc(64, 1).toString('base64');
  return { dir, appDir, context, bytes, release: { version: '2.2.0', platform: platform === 'darwin' ? 'macos' : 'linux', arch: 'x64', asset, assets: [asset] } };
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

test('portable Linux cannot update an unrelated inherited AppImage or an absent mount', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'Other.AppImage'), otherDir = path.join(f.dir, 'OtherAppDir');
  await fs.writeFile(image, 'other application'); await fs.mkdir(otherDir);
  for (const environment of [{ APPIMAGE: image, APPDIR: otherDir }, { APPIMAGE: image }, { APPIMAGE: image, APPDIR: 'relative-mount' }]) {
    let requests = 0, spawns = 0;
    const before = (await fs.readdir(f.dir)).sort();
    const adapter = adapterFactory()(f.context, { environment, fetcher: async () => { requests++; throw Error('must not fetch'); }, spawn() { spawns++; throw Error('must not spawn'); } });
    assert.equal(adapter.supported, false);
    await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /unsupported-installation/);
    assert.equal(requests, 0); assert.equal(spawns, 0); assert.deepEqual((await fs.readdir(f.dir)).sort(), before);
    assert.equal(await fs.readFile(image, 'utf8'), 'other application'); await assert.rejects(fs.access(f.context.userDataDirectory));
  }
});

test('Linux requires its executable, application and resources to belong to the AppDir', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  for (const field of ['executablePath', 'applicationDirectory', 'resourcesDirectory']) {
    const foreign = path.join(f.dir, field);
    if (field === 'executablePath') await fs.writeFile(foreign, 'foreign executable'); else await fs.mkdir(foreign);
    const adapter = adapterFactory()({ ...f.context, [field]: foreign }, { environment: { APPIMAGE: image, APPDIR: f.appDir } });
    assert.equal(adapter.supported, false);
    await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /unsupported-installation/);
  }
  await assert.rejects(fs.access(f.context.userDataDirectory));
});

test('Linux does not accept an AppDir alias in place of the runtime mount', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'), alias = path.join(f.dir, 'mount-alias');
  await fs.writeFile(image, 'old'); await fs.symlink(f.appDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const adapter = adapterFactory()(f.context, { environment: { APPIMAGE: image, APPDIR: alias } });
  assert.equal(adapter.supported, false);
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /unsupported-installation/);
  await assert.rejects(fs.access(f.context.userDataDirectory));
});

test('Linux rejects environment drift before preparing without creating update state', async t => {
  for (const key of ['APPIMAGE', 'APPDIR']) {
    const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
    const environment = { APPIMAGE: image, APPDIR: f.appDir };
    let requests = 0;
    const adapter = adapterFactory()(f.context, { environment, fetcher: async () => { requests++; throw Error('must not fetch'); } });
    assert.equal(adapter.supported, true); environment[key] = path.join(f.dir, 'unrelated');
    await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /unsupported-installation/);
    assert.equal(requests, 0); await assert.rejects(fs.access(f.context.userDataDirectory));
  }
});

test('Linux rejects an AppDir pathname substituted before prepare or handoff', async t => {
  for (const phase of ['prepare', 'handoff']) {
    const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
    let spawns = 0;
    const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, spawn() { spawns++; throw Error('must not spawn'); } });
    assert.equal(adapter.supported, true);
    const prepared = phase === 'handoff' ? await adapter.prepare(f.release, new AbortController().signal, () => {}) : undefined;
    await fs.rename(f.appDir, f.appDir + '-retained'); await fs.mkdir(f.context.resourcesDirectory, { recursive: true }); await fs.writeFile(f.context.executablePath, 'foreign replacement');
    await assert.rejects(phase === 'prepare' ? adapter.prepare(f.release, new AbortController().signal, () => {}) : adapter.handoff(prepared), /unsupported-installation/);
    assert.equal(spawns, 0); assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(await fs.readFile(f.context.executablePath, 'utf8'), 'foreign replacement');
    if (phase === 'prepare') await assert.rejects(fs.access(f.context.userDataDirectory));
    await adapter.cancel();
  }
});

test('Linux revalidates the bound mount before handoff and after relaunch acknowledgement', async t => {
  for (const phase of ['handoff', 'acknowledgement']) {
    const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
    const environment = { APPIMAGE: image, APPDIR: f.appDir }; let spawns = 0;
    const dependencies = linuxDependencies(f.bytes);
    const adapter = adapterFactory()(f.context, { ...dependencies, environment, spawn(...args) { spawns++; const child = dependencies.spawn(...args); environment.APPDIR = path.join(f.dir, 'unrelated'); return child; } });
    const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
    if (phase === 'handoff') environment.APPDIR = path.join(f.dir, 'unrelated');
    await assert.rejects(adapter.handoff(prepared), phase === 'handoff' ? /unsupported-installation/ : /installer-failed/);
    assert.equal(spawns, phase === 'handoff' ? 0 : 1); assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(f.context.quit, undefined);
    await adapter.cancel();
  }
});
test('Linux verifies exact downloaded bytes before a separately authorized handoff', async t => {
  const f = await fixture(t, 'linux');
  const image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(f.context.quit, undefined);
  await assert.rejects(adapter.handoff({ ...prepared, id: 'forged' }), /installer-failed/);
  await adapter.handoff(prepared); assert.deepEqual(await fs.readFile(image), f.bytes); assert.equal(f.context.quit, true);
  await assert.rejects(adapter.handoff(prepared), /installer-failed/);
});
test('Linux hash mismatch and wrong release cannot install', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies('bad'), environment: { APPIMAGE: image, APPDIR: f.appDir } });
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /download-invalid/);
  await assert.rejects(adapter.prepare({ ...f.release, arch: 'arm64' }, new AbortController().signal, () => {}), /release-invalid/);
});
test('already-cancelled Linux preparation does not create or invoke an updater', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'generated');
  let invoked = false;
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, fetcher: async () => { invoked = true; throw Error('must not run'); } });
  await assert.rejects(adapter.prepare(f.release, AbortSignal.abort(), () => {}), /installer-cancelled/); assert.equal(invoked, false);
});
test('a definite Linux transfer failure permits a fresh preparation', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  let attempts = 0;
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, fetcher: async () => { attempts++; return new Response(f.bytes); }, rename: async () => { throw Error('private fixture diagnostic'); } });
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
    const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, fetcher: async url => { requests.push(url); return response(f.bytes); } });
    await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), error => error.message === code);
    assert.deepEqual(requests, [f.release.asset.url]); assert.equal(await fs.readFile(image, 'utf8'), 'old');
    assert.equal(f.context.quit, undefined);
  }
});
test('Linux READY acknowledgement followed by waiter exit cannot replace the current image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, spawn: () => {
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
    const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir } });
    const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
    const stage = (await fs.readdir(f.dir)).find(name => name.startsWith('.putio-update-'));
    await fs.writeFile(target === 'original' ? image : path.join(f.dir, stage), 'changed fixture');
    await assert.rejects(adapter.handoff(prepared), error => ['installer-failed', 'download-invalid'].includes(error.message));
    assert.equal(await fs.readFile(image, 'utf8'), target === 'original' ? 'changed fixture' : 'old'); assert.equal(f.context.quit, undefined);
  }
});
test('Linux relaunch acknowledgement timeout preserves the current image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, handoffTimeoutMs: 20, spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('exit', 1); return child;
  } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'installer-failed');
  assert.equal(await fs.readFile(image, 'utf8'), 'old'); assert.equal(f.context.quit, undefined);
});
test('Linux post-commit failure reports restart required and retains the complete new image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  let syncs = 0;
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir }, syncDirectory: async () => { if (++syncs === 2) throw Error('generated post-rename failure'); } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), error => error.message === 'restart-required');
  assert.deepEqual(await fs.readFile(image), f.bytes); assert.equal(f.context.quit, undefined);
});
test('Linux cancellation removes only the owned staging image', async t => {
  const f = await fixture(t, 'linux'), image = path.join(f.dir, 'PutioManager.AppImage'); await fs.writeFile(image, 'old');
  const adapter = adapterFactory()(f.context, { ...linuxDependencies(f.bytes), environment: { APPIMAGE: image, APPDIR: f.appDir } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await adapter.cancel();
  assert.equal((await fs.readdir(f.dir)).filter(name => name.startsWith('.putio-update-')).length, 0); assert.equal(await fs.readFile(image, 'utf8'), 'old');
  await assert.rejects(adapter.handoff(prepared), /installer-failed/);
});

async function macFixture(t) {
  const f = await fixture(t, 'darwin');
  const helper = path.join(f.context.resourcesDirectory, 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.writeFile(helper, 'generated');
  f.options = { fetcher: async () => new Response(f.bytes) };
  return f;
}
function macChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.unref = () => {};
  child.kill = () => { if (child.exitCode == null) { child.exitCode = 1; child.emit('exit', 1); } };
  child.event = event => child.stdout.write(JSON.stringify({ schema: 1, ...event }) + '\n');
  child.finish = code => { child.exitCode = code; child.emit('exit', code); queueMicrotask(() => child.emit('close', code)); };
  return child;
}
test('Mac preparation and cancellation never start native extraction or an installer', async t => {
  const f = await macFixture(t); let starts = 0;
  const adapter = adapterFactory()(f.context, { ...f.options, spawn: () => { starts++; throw Error('must not start'); } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  assert.equal(starts, 0); assert.equal(f.context.quit, undefined);
  await adapter.cancel(); await assert.rejects(adapter.handoff(prepared), /installer-failed/);
  assert.equal(starts, 0);
  const { readNativeUpdateOutcome } = require('../dist/desktop/platform-updates.js');
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), { phase: 'failed', errorCode: 'installer-cancelled' });
});
test('Mac parent exit after preparation cannot leave a native installer running', async t => {
  const f = await macFixture(t), marker = path.join(f.dir, 'native-started');
  const script = `const fs=require('node:fs');const {createNativeUpdateAdapter}=require(${JSON.stringify(require.resolve('../dist/desktop/platform-updates.js'))});const adapter=createNativeUpdateAdapter(${JSON.stringify(f.context)},{fetcher:async()=>new Response(Buffer.from(${JSON.stringify(f.bytes.toString('base64'))},'base64')),spawn:()=>{fs.writeFileSync(${JSON.stringify(marker)},'started');throw Error()}});adapter.prepare(${JSON.stringify(f.release)},new AbortController().signal,()=>{}).then(()=>process.exit(0)).catch(()=>process.exit(1));`;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0); await assert.rejects(fs.access(marker));
});
test('Mac rejects absent signatures, wrong bytes and aborted preparation without starting a helper', async t => {
  const f = await macFixture(t); let starts = 0;
  const adapter = adapterFactory()(f.context, { fetcher: async () => new Response('corrupt'), spawn: () => { starts++; throw Error(); } });
  for (const ed25519 of [undefined, 'invalid', Buffer.alloc(63).toString('base64')]) await assert.rejects(adapter.prepare({ ...f.release, asset: { ...f.release.asset, ed25519 } }, new AbortController().signal, () => {}), /release-invalid/);
  await assert.rejects(adapter.prepare(f.release, AbortSignal.abort(), () => {}), /installer-cancelled/);
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /download-invalid/);
  assert.equal(starts, 0);
});
test('Mac only serves frozen verified bytes on nonce-scoped loopback routes after handoff', async t => {
  const f = await macFixture(t), child = macChild(); let starts = 0, feedURL, archiveURL, observed;
  const requests = [];
  const adapter = adapterFactory()(f.context, { fetcher: async url => { requests.push(url); return new Response(f.bytes); }, spawn: (_exe, args, options) => {
    starts++; feedURL = args[args.indexOf('--feed-url') + 1]; archiveURL = options.env.PUTIO_UPDATER_EXPECTED_URL;
    assert.equal(options.env.PUTIO_UPDATER_AUTHORIZED, '1'); assert.equal(options.env.PUTIO_UPDATER_EXPECTED_SIGNATURE, f.release.asset.ed25519); assert.equal(options.env.PUTIO_UPDATER_EXPECTED_BYTES, String(f.bytes.length));
    observed = (async () => {
      assert.match(feedURL, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36}\/appcast\.xml$/);
      for (let i = 0; i < 40; i++) assert.equal((await fetch(new URL('/other', feedURL))).status, 404);
      assert.equal((await fetch(archiveURL, { method: 'POST' })).status, 404);
      assert.equal((await fetch(archiveURL, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
      const head = await fetch(archiveURL, { method: 'HEAD' }); assert.equal(Number(head.headers.get('content-length')), f.bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
      const part = await fetch(archiveURL, { headers: { Range: 'bytes=1-2' } }); assert.equal(part.status, 206); assert.deepEqual(Buffer.from(await part.arrayBuffer()), f.bytes.subarray(1, 3));
      const feed = await (await fetch(feedURL)).text(); assert.ok(feed.includes(f.release.asset.ed25519)); assert.ok(feed.includes(archiveURL)); assert.ok(!feed.includes(f.dir));
      const bytes = Buffer.from(await (await fetch(archiveURL)).arrayBuffer()); assert.deepEqual(bytes, f.bytes);
      child.event({ phase: 'available', version: '2.2.0' }); child.event({ phase: 'ready' });
    })(); observed.catch(() => child.finish(1));
    child.stdin.on('data', data => { assert.equal(data.toString(), 'install\n'); child.event({ phase: 'finished', relaunched: true }); child.finish(0); });
    return child;
  } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {}); assert.equal(starts, 0);
  try { await adapter.handoff(prepared); } catch (error) { await observed; throw error; } await observed;
  assert.deepEqual(requests, [f.release.asset.url]); assert.equal(starts, 1);
  await assert.rejects(fetch(feedURL));
  const { readNativeUpdateOutcome } = require('../dist/desktop/platform-updates.js');
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.2.0'), { phase: 'updated' });
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), { phase: 'restart-required', errorCode: 'restart-required' });
});
test('Mac already-terminated-host completion is allowed only inside authorized handoff', async t => {
  const f = await macFixture(t), child = macChild(); let starts = 0;
  const adapter = adapterFactory()(f.context, { ...f.options, spawn: () => { starts++; queueMicrotask(() => { child.event({ phase: 'available', version: '2.2.0' }); child.event({ phase: 'finished', relaunched: false }); child.finish(0); }); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {}); assert.equal(starts, 0);
  await adapter.handoff(prepared); assert.equal(starts, 1);
});
test('Mac handoff rejects changed staging bytes before launching native code', async t => {
  const f = await macFixture(t); let starts = 0;
  const adapter = adapterFactory()(f.context, { ...f.options, spawn: () => { starts++; throw Error(); } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  const root = path.join(f.context.userDataDirectory, 'desktop-updates'), op = JSON.parse(await fs.readFile(path.join(root, 'native-operation.json')));
  await fs.writeFile(path.join(root, op.directory, 'verified-update.msi'), 'changed');
  await assert.rejects(adapter.handoff(prepared), /download-invalid/); assert.equal(starts, 0);
});
test('Mac malformed, early-exit and controlled helper errors reject authorized handoff promptly', async t => {
  for (const kind of ['malformed', 'ready-exit', 'signature-invalid', 'permission-required']) {
    const f = await macFixture(t), child = macChild();
    const adapter = adapterFactory()(f.context, { ...f.options, spawn: () => { queueMicrotask(() => {
      if (kind === 'malformed') child.stdout.write('private /fixture/path\n');
      else if (kind === 'ready-exit') { child.event({ phase: 'available', version: '2.2.0' }); child.event({ phase: 'ready' }); child.finish(1); }
      else child.event({ phase: 'failed', code: kind, detail: 'private /fixture/path' });
    }); return child; } });
    const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
    await assert.rejects(adapter.handoff(prepared), error => error.message === (kind === 'malformed' ? 'release-invalid' : kind === 'ready-exit' ? 'installer-failed' : kind));
    await adapter.cancel(); const next = await adapter.prepare(f.release, new AbortController().signal, () => {}); assert.notEqual(next.id, prepared.id); await adapter.cancel();
  }
});
test('Mac helper deadline closes the private listener and records uncertain ownership', async t => {
  const f = await macFixture(t), child = macChild(); let feed;
  const adapter = adapterFactory()(f.context, { ...f.options, handoffTimeoutMs: 20, spawn: (_exe, args) => { feed = args.at(-1); return child; } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), /restart-required/); await assert.rejects(fetch(feed));
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /installer-busy/);
  const { readNativeUpdateOutcome } = require('../dist/desktop/platform-updates.js');
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), { phase: 'restart-required', errorCode: 'restart-required' });
  child.finish(1);
});
test('Mac cancels a streaming preparation without ever creating an installer', async t => {
  const f = await macFixture(t); let starts = 0, readStarted;
  const reading = new Promise(resolve => { readStarted = resolve; });
  const adapter = adapterFactory()(f.context, { fetcher: async (_url, options) => new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(Error('generated cancellation')), { once: true }); readStarted(); } })), spawn: () => { starts++; throw Error(); } });
  const preparing = adapter.prepare(f.release, new AbortController().signal, () => {}); await reading; await adapter.cancel();
  await assert.rejects(preparing, /installer-cancelled/); assert.equal(starts, 0);
});
test('Mac loopback ingestion rejects cache identity changes after handoff begins', async t => {
  const f = await macFixture(t), child = macChild(); let attempted;
  const adapter = adapterFactory()(f.context, { ...f.options, spawn: (_exe, _args, options) => {
    attempted = (async () => {
      const root = path.join(f.context.userDataDirectory, 'desktop-updates'), op = JSON.parse(await fs.readFile(path.join(root, 'native-operation.json')));
      await fs.writeFile(path.join(root, op.directory, 'verified-update.msi'), Buffer.alloc(f.bytes.length));
      await assert.rejects(fetch(options.env.PUTIO_UPDATER_EXPECTED_URL));
    })(); attempted.catch(() => child.finish(1)); return child;
  } });
  const prepared = await adapter.prepare(f.release, new AbortController().signal, () => {});
  await assert.rejects(adapter.handoff(prepared), /download-invalid/); await attempted;
});
test('native relaunch outcome records are bounded, allowlisted and cannot name foreign directories', async t => {
  const f = await macFixture(t), { readNativeUpdateOutcome } = require('../dist/desktop/platform-updates.js');
  const adapter = adapterFactory()(f.context, { ...f.options }); await adapter.prepare(f.release, new AbortController().signal, () => {});
  const file = path.join(f.context.userDataDirectory, 'desktop-updates', 'native-operation.json'), operation = JSON.parse(await fs.readFile(file));
  await fs.writeFile(file, JSON.stringify({ ...operation, phase: 'installing' }));
  const receipt = path.join(path.dirname(file), operation.directory, 'receipt.json');
  await fs.writeFile(receipt, JSON.stringify({ schema: 1, phase: 'failed', code: 'signature-invalid', detail: 'CANARY_PRIVATE /private/profile' }));
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), { phase: 'failed', errorCode: 'signature-invalid' });
  await fs.writeFile(receipt, JSON.stringify({ schema: 1, phase: 'failed', code: 'CANARY_PRIVATE /private/profile' }));
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), { phase: 'restart-required', errorCode: 'restart-required' });
  await fs.writeFile(file, JSON.stringify({ ...operation, phase: 'failed', errorCode: 'restart-required' }));
  await fs.writeFile(receipt, JSON.stringify({ schema: 1, phase: 'failed', code: 'permission-required' }));
  assert.deepEqual(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), { phase: 'failed', errorCode: 'permission-required' });
  await fs.writeFile(file, JSON.stringify({ ...operation, directory: '../private', phase: 'installing' }));
  assert.equal(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), undefined);
  await fs.writeFile(file, 'x'.repeat(4097)); assert.equal(await readNativeUpdateOutcome(f.context.userDataDirectory, '2.1.0'), undefined);
});
test('Mac cleanup preserves substituted operation directories, files and unknown contents', async t => {
  for (const kind of ['directory', 'file', 'unknown']) {
    const f = await macFixture(t), adapter = adapterFactory()(f.context, f.options);
    await adapter.prepare(f.release, new AbortController().signal, () => {});
    const root = path.join(f.context.userDataDirectory, 'desktop-updates'), op = JSON.parse(await fs.readFile(path.join(root, 'native-operation.json'))), directory = path.join(root, op.directory), payload = path.join(directory, 'verified-update.msi');
    if (kind === 'directory') { await fs.rename(directory, path.join(f.dir, 'retained-owned')); await fs.mkdir(directory); }
    if (kind === 'file') await fs.rename(payload, path.join(f.dir, 'retained-file'));
    if (kind !== 'unknown') await fs.writeFile(payload, 'foreign payload');
    const sentinel = path.join(directory, 'foreign-sentinel'); await fs.writeFile(sentinel, 'generated sentinel');
    await adapter.cancel();
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'generated sentinel');
    if (kind !== 'unknown') assert.equal(await fs.readFile(payload, 'utf8'), 'foreign payload');
    else await assert.rejects(fs.access(payload));
  }
});
test('Mac failed preparation does not recursively remove a substituted operation directory', async t => {
  const f = await macFixture(t); let sentinel, renameBlocked = false;
  const adapter = adapterFactory()(f.context, { fetcher: async () => {
    const root = path.join(f.context.userDataDirectory, 'desktop-updates'), op = JSON.parse(await fs.readFile(path.join(root, 'native-operation.json'))), directory = path.join(root, op.directory);
    try { await fs.rename(directory, path.join(f.dir, 'retained-owned')); } catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) renameBlocked = true; throw error; } await fs.mkdir(directory);
    sentinel = path.join(directory, 'foreign-sentinel'); await fs.writeFile(sentinel, 'generated sentinel');
    throw Error('generated transfer failure');
  } });
  await assert.rejects(adapter.prepare(f.release, new AbortController().signal, () => {}), /network/);
  if (renameBlocked) { t.skip('Windows prevents open-directory substitution; native Linux/macOS CI exercises this case.'); return; }
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'generated sentinel');
});
test('Mac helper transport policy permits only exact loopback HTTP without a broad exception', async () => {
  const { patchHelperInfoPlist } = await import('../scripts/macos-updater/patch-sparkle.mjs');
  const original = '<plist><dict><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>';
  const result = patchHelperInfoPlist(original);
  assert.deepEqual([...result.matchAll(/<key>([^<]+)<\/key>/g)].map(match => match[1]), ['NSAppTransportSecurity', 'NSExceptionDomains', '127.0.0.1', 'NSIncludesSubdomains', 'NSExceptionAllowsInsecureHTTPLoads']);
  assert.match(result, /<key>NSIncludesSubdomains<\/key><false\/>/); assert.match(result, /<key>NSExceptionAllowsInsecureHTTPLoads<\/key><true\/>/);
  assert.ok(!result.includes('NSAllowsArbitraryLoads')); assert.ok(!result.includes('NSAllowsLocalNetworking'));
  assert.throws(() => patchHelperInfoPlist('<plist><dict/></plist>'), /policy/);
});
