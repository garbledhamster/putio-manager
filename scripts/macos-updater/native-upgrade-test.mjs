import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stageMacUpdater } from './package.mjs';
import { prepareFixtureApplication, waitForFixtureResult } from './native-fixture.mjs';

function run(command, args, options = {}) { const result = spawnSync(command, args, { stdio: 'pipe', ...options }); if (result.status !== 0 || result.error) throw new Error('Native Mac fixture command failed.'); return result.stdout; }
function helperCycle(app, feed, { cancelReady = false, descriptor } = {}) {
  const executable = path.join(app, 'Contents', 'Resources', 'updater', 'sparkle.app', 'Contents', 'MacOS', 'sparkle');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [app, '--check-immediately', '--user-agent-name', 'PutioManagerFixture', '--feed-url', feed], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PUTIO_UPDATER_EXPECTED_VERSION: descriptor.version, PUTIO_UPDATER_EXPECTED_URL: descriptor.url, PUTIO_UPDATER_EXPECTED_SIGNATURE: descriptor.ed25519, PUTIO_UPDATER_EXPECTED_BYTES: String(descriptor.bytes) } });
    let buffer = '', last; const failureCodes = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native helper fixture timed out.')); }, 180000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Native helper fixture failed to start.')); });
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > 16384) { child.kill(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { last = JSON.parse(line); } catch { child.kill(); return; }
        if (last.phase === 'failed') failureCodes.push(last.code);
        if (last.phase === 'ready') child.stdin.end(cancelReady ? 'cancel\n' : 'unexpected\n');
      }
    });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, last, failureCodes }); });
  });
}
export async function testMacUpgrade() {
  if (process.platform !== 'darwin' || process.env.CI !== 'true') throw new Error('Run real Mac updates only in disposable native CI.');
  const root = path.resolve('release/native-update-fixture/mac');
  const profile = path.join(root, 'profile'), source = path.resolve(`release/PutioManager-darwin-${process.arch}/PutioManager.app`);
  await mkdir(profile, { recursive: true });
  const before = path.join(root, 'old', 'PutioManager.app'), after = path.join(root, 'new', 'PutioManager.app');
  const keys = generateKeyPairSync('ed25519'), jwk = keys.publicKey.export({ format: 'jwk' });
  const publicKey = Buffer.from(jwk.x, 'base64url').toString('base64');
  const payloads = new Map();
  let archiveRequests = 0;
  const server = createServer((request, response) => { const value = payloads.get(request.url); if (!value) { response.writeHead(404); response.end(); return; } if (request.url.endsWith('.zip')) archiveRequests++; response.writeHead(200, { 'content-length': value.length }); response.end(value); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const resultFile = path.join(root, 'result.json'), configFile = path.join(root, 'configuration.json');
  try {
    for (const [app, version] of [[before, '2.0.0'], [after, '2.0.1']]) {
      await prepareFixtureApplication(source, app, version);
      const plist = path.join(app, 'Contents', 'Info.plist');
      for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) run('/usr/bin/plutil', ['-replace', key, '-string', version, plist]);
      await stageMacUpdater(app, { fixturePublicKey: publicKey });
    }
    const archive = path.join(root, 'PutioManager-2.0.1-macos-' + process.arch + '-update.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', after, archive]);
    const bytes = await readFile(archive), signature = sign(null, bytes, keys.privateKey);
    // Prove interoperability in both directions using an independent ephemeral seed.
    const privateJwk = keys.privateKey.export({ format: 'jwk' }), seedFile = path.join(root, 'fixture-key');
    await writeFile(seedFile, Buffer.from(privateJwk.d, 'base64url').toString('base64'), { mode: 0o600 });
    const tool = path.resolve('release/native-updater/mac/sign_update');
    run(tool, ['--ed-key-file', seedFile, '--verify', archive, signature.toString('base64')]);
    const nativeSignature = run(tool, ['--ed-key-file', seedFile, '-p', archive]).toString().trim();
    if (!verify(null, bytes, keys.publicKey, Buffer.from(nativeSignature, 'base64'))) throw new Error('Native archive signing interoperability failed.');
    await rm(seedFile);
    const name = path.basename(archive), archiveURL = base + name;
    payloads.set('/' + name, bytes);
    const descriptor = { version: '2.0.1', url: archiveURL, bytes: bytes.length, ed25519: signature.toString('base64') };
    const appcast = (signatureValue, length = bytes.length) => Buffer.from(`<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Generated fixture</title><item><sparkle:version>2.0.1</sparkle:version><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="${archiveURL}" length="${length}" type="application/octet-stream" sparkle:edSignature="${signatureValue}"/></item></channel></rss>`);
    // Another archive signed by the same project key cannot replace this descriptor.
    const replayBytes = Buffer.from(bytes); replayBytes[0] ^= 1;
    const replaySignature = sign(null, replayBytes, keys.privateKey).toString('base64');
    for (const feed of [appcast(replaySignature), appcast(descriptor.ed25519, bytes.length + 1)]) {
      payloads.set('/appcast.xml', feed); const requestsBefore = archiveRequests;
      const rejected = await helperCycle(before, base + 'appcast.xml', { descriptor });
      if (!rejected.failureCodes.includes('release-invalid') || archiveRequests !== requestsBefore) throw new Error('Native descriptor binding accepted a replay or downloaded a mismatched archive.');
    }
    console.log('Verified native descriptor binding rejects archive replay and size mismatch before download.');
    const invalidSignature = Buffer.alloc(64).toString('base64');
    payloads.set('/appcast.xml', appcast(invalidSignature));
    const corrupt = await helperCycle(before, base + 'appcast.xml', { descriptor: { ...descriptor, ed25519: invalidSignature } });
    if (corrupt.code === 0 || !corrupt.failureCodes.includes('signature-invalid')) {
      const codes = corrupt.failureCodes.filter(value => ['release-invalid', 'signature-invalid', 'download-invalid', 'installer-failed', 'network', 'permission-required', 'installer-cancelled'].includes(value)).slice(0, 8);
      throw new Error(`Native archive signature rejection was not confirmed (exit ${Number.isInteger(corrupt.code) ? corrupt.code : 'signal'}; controlled failures ${JSON.stringify(codes)}).`);
    }
    console.log('Verified native archive signature rejection before installation.');
    payloads.set('/appcast.xml', appcast(signature.toString('base64')));
    payloads.set('/' + name, Buffer.concat([bytes, Buffer.from([0])]));
    const oversized = await helperCycle(before, base + 'appcast.xml', { descriptor });
    if (!oversized.failureCodes.includes('download-invalid')) throw new Error('Native helper did not cancel an oversized archive response.');
    payloads.set('/' + name, bytes);
    const cancelled = await helperCycle(before, base + 'appcast.xml', { cancelReady: true, descriptor });
    if (cancelled.last?.phase === 'finished') throw new Error('Native Sparkle installed a cancelled update.');
    if (run('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', path.join(before, 'Contents', 'Info.plist')]).toString().trim() !== '2.0.0') throw new Error('Native cancellation changed the application.');
    const ownerDirectory = path.dirname(before);
    try {
      await chmod(ownerDirectory, 0o555);
      const denied = await helperCycle(before, base + 'appcast.xml', { descriptor });
      if (![3, 8].includes(denied.code)) throw new Error('Noninteractive native update did not stop for authorization.');
    } finally { await chmod(ownerDirectory, 0o755); }
    const asset = { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ed25519: descriptor.ed25519, url: `https://github.com/garbledhamster/putio-manager/releases/download/v2.0.1/${name}` };
    await writeFile(configFile, JSON.stringify({ profile, result: resultFile, nextVersion: '2.0.1', feed: base + 'appcast.xml', archiveURL, release: { version: '2.0.1', platform: 'macos', arch: process.arch, asset, assets: [asset] } }));
    const child = spawn(path.join(before, 'Contents', 'MacOS', 'PutioManager'), ['--enable-sandbox'], { stdio: 'ignore', env: { ...process.env, PUTIO_NATIVE_FIXTURE_CONFIG: configFile } });
    try { await waitForFixtureResult(resultFile); } finally { child.kill(); }
    // Verify actual replaced bundle identity, not just a progress receipt.
    if (run('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', path.join(before, 'Contents', 'Info.plist')]).toString().trim() !== '2.0.1') throw new Error('Mac installed version did not change.');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', before]);
    console.log('Verified native Mac A-to-B replacement, relaunch, profile preservation and signing.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await testMacUpgrade();
