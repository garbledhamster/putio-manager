import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyRelease } from '../scripts/verify-public-release.mjs';

async function appFixture(t, platform = 'win32') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'putio-app-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefix = platform === 'darwin' ? 'PutioManager.app/Contents/Resources/app' : 'resources/app';
  const files = [`${prefix}/package.json`, `${prefix}/dist/desktop/main.js`, platform === 'darwin' ? 'PutioManager.app/Contents/MacOS/PutioManager' : platform === 'win32' ? 'PutioManager.exe' : 'putio-manager'];
  for (const name of files) { await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), name.endsWith('.json') ? '{"name":"putio-manager","version":"2.2.0"}' : 'generated fixture'); }
  return { directory, prefix };
}
test('explicit application mode accepts the packaged app without portable headless files', async t => {
  const { directory } = await appFixture(t);
  const result = await verifyRelease('app', directory, { platform: 'win32' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'app');
});
test('application mode preserves nested credential and profile denials', async t => {
  const { directory, prefix } = await appFixture(t);
  await mkdir(path.join(directory, prefix, 'node_modules', 'fixture'), { recursive: true });
  await writeFile(path.join(directory, prefix, 'node_modules', 'fixture', 'settings.json'), '{"token":"generated-fixture"}');
  const result = await verifyRelease('app', directory, { platform: 'win32' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(value => value.category === 'private-runtime-or-operator-file'));
});
test('application mode cannot bless an arbitrary directory or wrong platform', async t => {
  const { directory } = await appFixture(t);
  assert.equal((await verifyRelease('app', directory, { platform: 'darwin' })).ok, false);
  await assert.rejects(verifyRelease('app', directory, { platform: 'unknown' }), /platform/i);
  assert.equal((await verifyRelease('artifact', directory)).ok, false);
});
test('AppImage payload audit requires the native AppRun and still scans authored launch text', async t => {
  const { directory } = await appFixture(t, 'linux');
  assert.equal((await verifyRelease('appimage', directory, { platform: 'linux' })).ok, false);
  await writeFile(path.join(directory, 'AppRun'), '#!/bin/sh\nexec ./putio-manager --enable-sandbox\n');
  assert.equal((await verifyRelease('appimage', directory, { platform: 'linux' })).ok, true);
  await writeFile(path.join(directory, 'fixture.desktop'), '[Desktop Entry]\nExec=' + '/' + ['home', 'private-person', 'app'].join('/') + '\n');
  const result = await verifyRelease('appimage', directory, { platform: 'linux' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(value => value.category === 'personal-home-path'));
});
function fixtureAsar(files) {
  const data = [], tree = { files: {} }; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    let current = tree.files;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) { current[part] ||= { files: {} }; current = current[part].files; }
    if (typeof content === 'object' && !Buffer.isBuffer(content)) { current[parts.at(-1)] = content; continue; }
    const raw = Buffer.from(content);
    current[parts.at(-1)] = { size: raw.length, offset: String(offset) };
    data.push(raw); offset += raw.length;
  }
  const json = Buffer.from(JSON.stringify(tree)), headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(headerSize, 4); header.writeUInt32LE(headerSize - 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16);
  return Buffer.concat([header, ...data]);
}
test('an ASAR payload must contain the actual app identity and desktop entrypoint', async t => {
  const { directory } = await appFixture(t);
  await rm(path.join(directory, 'resources/app'), { recursive: true });
  await writeFile(path.join(directory, 'resources/app.asar'), fixtureAsar({ 'fixture.txt': 'generated fixture' }));
  assert.equal((await verifyRelease('app', directory, { platform: 'win32' })).ok, false);
  await writeFile(path.join(directory, 'resources/app.asar'), fixtureAsar({ 'package.json': '{"name":"putio-manager","version":"2.2.0"}', 'dist/desktop/main.js': 'generated fixture' }));
  assert.equal((await verifyRelease('app', directory, { platform: 'win32' })).ok, true);
});
test('Mac application audit scans bundled helper resources and raw private denylist matches', async t => {
  const { directory } = await appFixture(t, 'darwin');
  const helper = path.join(directory, 'PutioManager.app/Contents/Frameworks/Updater.app/Contents/Resources');
  await mkdir(helper, { recursive: true });
  await writeFile(path.join(helper, 'fixture.plist'), '<plist>private-fixture-indicator</plist>');
  const result = await verifyRelease('app', directory, { platform: 'darwin', privateTerms: ['private-fixture-indicator'] });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(value => value.category === 'private-denylist-match'));
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-indicator/);
});
test('nested ASAR archives cannot exhaust recursive inspection', async t => {
  const { directory, prefix } = await appFixture(t);
  let archive = fixtureAsar({ 'fixture.txt': 'generated fixture' });
  for (let index = 0; index < 10; index++) archive = fixtureAsar({ 'nested.asar': archive });
  await writeFile(path.join(directory, prefix, 'nested.asar'), archive);
  await assert.rejects(verifyRelease('app', directory, { platform: 'win32' }), /limit/i);
});
test('application audit rejects a different product identity even with matching runtime filenames', async t => {
  const { directory, prefix } = await appFixture(t);
  await writeFile(path.join(directory, prefix, 'package.json'), '{"name":"different-product","version":"2.2.0"}');
  assert.equal((await verifyRelease('app', directory, { platform: 'win32' })).ok, false);
});
test('ASAR link and unpacked metadata cannot hide prohibited private filenames', async t => {
  const { directory, prefix } = await appFixture(t);
  for (const entry of [{ link: 'fixture.txt' }, { unpacked: true, size: 1 }]) {
    await writeFile(path.join(directory, prefix, 'nested.asar'), fixtureAsar({ 'settings.json': entry }));
    const result = await verifyRelease('app', directory, { platform: 'win32' });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(finding => finding.category === 'private-runtime-or-operator-file'));
  }
});
test('installer resource audits require an exact fixed inventory and scan metadata contents', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'putio-bootstrap-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expectedPaths = Object.freeze(['manifest.xml', 'runtime/bootstrapper.exe']);
  await mkdir(path.join(directory, 'runtime'));
  await writeFile(path.join(directory, 'manifest.xml'), '<manifest>generated fixture</manifest>');
  await writeFile(path.join(directory, 'runtime/bootstrapper.exe'), 'generated binary fixture');
  await assert.rejects(verifyRelease('installer-resources', directory), /inventory/i);
  assert.equal((await verifyRelease('installer-resources', directory, { expectedPaths })).ok, true);
  await writeFile(path.join(directory, 'unexpected.txt'), 'generated fixture');
  await assert.rejects(verifyRelease('installer-resources', directory, { expectedPaths }), /inventory/i);
  await rm(path.join(directory, 'unexpected.txt'));
  await writeFile(path.join(directory, 'manifest.xml'), '<manifest>' + '/' + ['Users', 'private-fixture-person', 'source'].join('/') + '</manifest>');
  const result = await verifyRelease('installer-resources', directory, { expectedPaths });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.category === 'personal-home-path'));
});
