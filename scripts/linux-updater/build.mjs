import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export async function buildLinuxUpdate() {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Build AppImages on a disposable native Linux CI runner.');
  const require = createRequire(import.meta.url), { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (require('electron-builder/package.json').version !== '26.18.0') throw new Error('Unexpected updater toolchain version.');
  await packageLinuxApplication({ packaged: path.resolve(`release/PutioManager-linux-${process.arch}`), version, outputDirectory: path.resolve('release-assets') });
}
export async function packageLinuxApplication({ packaged, version, outputDirectory, fixtureFeed }) {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Build AppImages on a disposable native Linux CI runner.');
  if (fixtureFeed && (!packaged.includes(`${path.sep}native-update-fixture${path.sep}`) || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(fixtureFeed))) throw new Error('Fixture feeds require an isolated loopback CI build.');
  const require = createRequire(import.meta.url);
  await readFile(path.join(packaged, 'resources', 'app', 'dist', 'desktop', 'platform-updates.js'));
  await mkdir('release/native-updater/linux', { recursive: true }); await mkdir(outputDirectory, { recursive: true });
  const stagedOutput = path.resolve(`release/native-updater/linux/output-${process.arch}-${version}`);
  const configuration = { appId: 'space.ourstuff.putiomanager', productName: 'PutioManager', executableName: 'PutioManager', extraMetadata: { version }, buildVersion: version, directories: { output: stagedOutput }, publish: fixtureFeed ? [{ provider: 'generic', url: fixtureFeed }] : [{ provider: 'github', owner: 'garbledhamster', repo: 'putio-manager' }], linux: { target: ['AppImage'], artifactName: `PutioManager-${version}-linux-\${arch}.AppImage`, executableName: 'PutioManager', category: 'Network', icon: 'src/ui/branding/putio-manager.png' }, appImage: { executableArgs: ['--enable-sandbox'] } };
  const file = path.resolve('release/native-updater/linux/builder.json'); await writeFile(file, JSON.stringify(configuration));
  const bin = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [bin, '--linux', 'AppImage', `--${process.arch}`, '--prepackaged', packaged, '--config', file, '--publish', 'never'], { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('AppImage packaging failed.');
  // Builder diagnostics/configuration are not public release assets.
  for (const name of [`PutioManager-${version}-linux-${process.arch}.AppImage`, process.arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml']) {
    await cp(path.join(stagedOutput, name), path.join(outputDirectory, name), { force: !!fixtureFeed, errorOnExist: !fixtureFeed });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await buildLinuxUpdate();
