import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Mac update packaging failed.');
}
export async function stageMacUpdater(applicationDirectory, { fixturePublicKey } = {}) {
  if (process.platform !== 'darwin') throw new Error('Mac updater staging requires macOS.');
  const app = applicationDirectory.endsWith('.app') ? path.resolve(applicationDirectory) : path.resolve(applicationDirectory, 'PutioManager.app');
  const require = createRequire(import.meta.url);
  const publicKey = fixturePublicKey ?? require('../../dist/desktop/update-public-key.js').UPDATE_PUBLIC_KEY_BASE64;
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) throw new Error('A configured update public key is required.');
  if (fixturePublicKey && (process.env.CI !== 'true' || !app.includes(`${path.sep}native-update-fixture${path.sep}`))) throw new Error('Fixture keys require an isolated CI application.');
  const built = path.resolve('release/native-updater/mac'), destination = path.join(app, 'Contents', 'Resources', 'updater');
  await mkdir(destination, { recursive: true });
  await cp(path.join(built, 'sparkle.app'), path.join(destination, 'sparkle.app'), { recursive: true, verbatimSymlinks: true });
  for (const name of ['LICENSE-Sparkle.txt', 'SPARKLE-PROVENANCE.txt']) await cp(path.join(built, name), path.join(destination, name));
  const plist = path.join(app, 'Contents', 'Info.plist');
  const values = { SUPublicEDKey: ['string', publicKey], SUFeedURL: ['string', `https://github.com/garbledhamster/putio-manager/releases/latest/download/appcast-${process.arch}.xml`], SUEnableAutomaticChecks: ['bool', 'false'], SUAutomaticallyUpdate: ['bool', 'false'], SUEnableSystemProfiling: ['bool', 'false'], SUShowReleaseNotes: ['bool', 'false'], SUVerifyUpdateBeforeExtraction: ['bool', 'true'] };
  for (const [key, [type, value]] of Object.entries(values)) run('/usr/bin/plutil', ['-replace', key, `-${type}`, value, plist]);
  // Sign nested code from the inside out. No entitlement/security bypasses are added.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  return app;
}
export async function packageMacUpdate() {
  if (process.platform !== 'darwin' || process.env.CI !== 'true') throw new Error('Package Mac updates on a disposable native CI runner.');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const app = path.resolve(`release/PutioManager-darwin-${process.arch}/PutioManager.app`);
  await mkdir('release-assets', { recursive: true });
  const archive = path.resolve(`release-assets/PutioManager-${version}-macos-${process.arch}-update.zip`);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await packageMacUpdate();
