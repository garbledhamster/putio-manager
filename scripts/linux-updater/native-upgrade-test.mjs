import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { packageLinuxApplication } from './build.mjs';
import { prepareFixtureApplication, waitForFixtureResult } from '../macos-updater/native-fixture.mjs';

export async function testLinuxUpgrade() {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Run real AppImage updates only in disposable native CI.');
  const root = path.resolve('release/native-update-fixture/linux'), profile = path.join(root, 'profile'), output = path.join(root, 'images');
  await mkdir(profile, { recursive: true }); await mkdir(output, { recursive: true });
  const payloads = new Map();
  const server = createServer((request, response) => { const bytes = payloads.get(request.url); if (!bytes) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const feed = `http://127.0.0.1:${server.address().port}/`;
  try {
    for (const [directory, version] of [['old', '2.0.0'], ['new', '2.0.1']]) {
      const packaged = path.join(root, directory);
      await prepareFixtureApplication(path.resolve(`release/PutioManager-linux-${process.arch}`), packaged, version);
      await packageLinuxApplication({ packaged, version, outputDirectory: output, fixtureFeed: feed });
    }
    const name = `PutioManager-2.0.1-linux-${process.arch}.AppImage`, bytes = await readFile(path.join(output, name));
    const channel = process.arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml';
    payloads.set('/' + name, bytes); payloads.set('/' + channel, await readFile(path.join(output, channel)));
    const configFile = path.join(root, 'configuration.json'), resultFile = path.join(root, 'result.json');
    const asset = { name, url: `https://github.com/garbledhamster/putio-manager/releases/download/v2.0.1/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(configFile, JSON.stringify({ profile, result: resultFile, nextVersion: '2.0.1', feed, archiveURL: feed + name, release: { version: '2.0.1', platform: 'linux', arch: process.arch, asset, assets: [asset] } }));
    const before = path.join(output, `PutioManager-2.0.0-linux-${process.arch}.AppImage`); await chmod(before, 0o755);
    const child = spawn(before, ['--enable-sandbox'], { stdio: 'ignore', env: { ...process.env, PUTIO_NATIVE_FIXTURE_CONFIG: configFile } });
    try { await waitForFixtureResult(resultFile); } finally { child.kill(); }
    console.log('Verified native AppImage A-to-B replacement, relaunch, engine closure and profile preservation.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await testLinuxUpgrade();
