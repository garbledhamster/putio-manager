import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Pure guard: native replacement tests run only on disposable hosted project runners. */
export function assertHostedNativeFixture(expectedPlatform, platform = process.platform, env = process.env) {
  if (!['darwin', 'linux'].includes(expectedPlatform) || platform !== expectedPlatform || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_REPOSITORY !== 'garbledhamster/putio-manager' || !env.RUNNER_TEMP) throw new Error('Native update execution is restricted to disposable hosted repository CI.');
}

/** Generated native fixture, never copied into a release application. */
export async function prepareFixtureApplication(source, target, version) {
  assertHostedNativeFixture(process.platform);
  if (!target.includes(`${path.sep}native-update-fixture${path.sep}`)) throw new Error('Use an isolated CI fixture application.');
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  const resources = process.platform === 'darwin' ? path.join(target, 'Contents', 'Resources') : path.join(target, 'resources');
  const appDirectory = path.join(resources, 'app');
  const packageFile = path.join(appDirectory, 'package.json'), manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  manifest.version = version; manifest.main = 'dist/desktop/native-update-fixture.js';
  await writeFile(packageFile, JSON.stringify(manifest));
  // LaunchServices may discard the launching process's environment on relaunch.
  // Embed only this disposable fixture's configuration locator in its generated entry.
  const configurationFile = path.join(process.platform === 'darwin' ? path.resolve(target, '../..') : path.resolve(target, '..'), 'configuration.json');
  await writeFile(path.join(appDirectory, manifest.main), `
const fs = require('node:fs/promises'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createNativeUpdateAdapter, readNativeUpdateOutcome } = require('./platform-updates');
const { createEngine } = require('../engine/engine');
const configuration = JSON.parse(require('node:fs').readFileSync(process.env.PUTIO_NATIVE_FIXTURE_CONFIG || ${JSON.stringify(configurationFile)}, 'utf8'));
app.setPath('userData', configuration.profile);
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Generated update fixture</title>');
  const engine = await createEngine({ stateDirectory: configuration.profile, credentials: { available: () => false, encrypt: () => { throw Error(); }, decrypt: () => { throw Error(); } } });
  if (app.getVersion() === configuration.nextVersion) {
    const snapshot = await engine.getSnapshot();
    if (snapshot.settings.speedLimitBytesPerSecond !== 12345 || await fs.readFile(path.join(configuration.profile, 'profile-marker'), 'utf8') !== 'preserved') throw Error('Fixture profile was not preserved.');
    if (await fs.readFile(path.join(configuration.profile, 'engine-closed'), 'utf8') !== 'closed') throw Error('Handoff occurred before fixture engine closure.');
    if ((await readNativeUpdateOutcome(configuration.profile, app.getVersion()))?.phase !== 'updated') throw Error('Fixture update outcome was not recovered.');
    await engine.close(); await fs.writeFile(configuration.result, JSON.stringify({ ok: true, version: app.getVersion(), profilePreserved: true, engineClosed: true, outcomeRecovered: true })); app.quit(); return;
  }
  await engine.execute('saveSettings', [{ speedLimitBytesPerSecond: 12345 }]);
  await fs.writeFile(path.join(configuration.profile, 'profile-marker'), 'preserved');
  const context = { platform: process.platform, arch: process.arch, currentVersion: app.getVersion(), isPackaged: app.isPackaged, resourcesDirectory: process.resourcesPath, applicationDirectory: process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : path.dirname(process.execPath), executablePath: process.execPath, userDataDirectory: configuration.profile, quitApplication: () => app.quit() };
  const dependencies = { fetcher: async (_url, options) => fetch(configuration.archiveURL, { signal: options.signal }) };
  const adapter = createNativeUpdateAdapter(context, dependencies);
  const prepared = await adapter.prepare(configuration.release, new AbortController().signal, () => {});
  // Exercise the exact engine-close contract before granting the native READY gate.
  await engine.close(); await fs.writeFile(path.join(configuration.profile, 'engine-closed'), 'closed');
  await adapter.handoff(prepared);
}).catch(async () => { await fs.writeFile(configuration.result, JSON.stringify({ ok: false, error: 'native-upgrade-fixture-failed' })); app.exit(1); });
`);
  return { appDirectory, resources };
}
export async function waitForFixtureResult(filename, milliseconds = 180000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { const value = JSON.parse(await readFile(filename, 'utf8')); if (!value.ok || !value.profilePreserved || !value.engineClosed || !value.outcomeRecovered) throw new Error('Native update did not preserve its fixture.'); return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Native update fixture did not complete.');
}
