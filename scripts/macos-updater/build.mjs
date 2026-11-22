import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchSparkleSource } from './patch-sparkle.mjs';

export const SPARKLE_VERSION = '2.10.1';
export const SPARKLE_COMMIT = 'ab7d71291238df6e0492143b120c9b696a35f603';
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Native updater build failed.');
}
export async function buildMacUpdater() {
  if (process.platform !== 'darwin' || process.env.CI !== 'true') throw new Error('Build the native updater on a disposable macOS CI runner.');
  const root = path.resolve('release/native-updater/mac'), source = path.join(root, 'source'), derived = path.join(root, 'derived');
  await mkdir(root, { recursive: true });
  run('git', ['clone', '--no-checkout', 'https://github.com/sparkle-project/Sparkle.git', source]);
  run('git', ['checkout', '--detach', SPARKLE_COMMIT], source);
  run('git', ['submodule', 'update', '--init', '--recursive'], source);
  const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== SPARKLE_COMMIT) throw new Error('Sparkle source identity did not match.');
  await patchSparkleSource(source);
  run('xcodebuild', ['-version']);
  run('xcodebuild', ['-project', 'Sparkle.xcodeproj', '-scheme', 'Distribution', '-configuration', 'Release', '-derivedDataPath', derived, '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', `ARCHS=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`, 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGN_IDENTITY=-', 'build'], source);
  // Distribution builds the framework and signing tools, but excludes sparkle-cli.
  // Build that separate upstream scheme so the copied helper includes our callbacks.
  run('xcodebuild', ['-project', 'Sparkle.xcodeproj', '-scheme', 'sparkle-cli', '-configuration', 'Release', '-derivedDataPath', derived, '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', `ARCHS=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`, 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGN_IDENTITY=-', 'build'], source);
  const products = path.join(derived, 'Build', 'Products', 'Release');
  await cp(path.join(products, 'sparkle.app'), path.join(root, 'sparkle.app'), { recursive: true, verbatimSymlinks: true });
  for (const tool of ['sign_update', 'generate_keys']) await cp(path.join(products, tool), path.join(root, tool));
  const license = await readFile(path.join(source, 'LICENSE'), 'utf8');
  await writeFile(path.join(root, 'LICENSE-Sparkle.txt'), license);
  await writeFile(path.join(root, 'SPARKLE-PROVENANCE.txt'), `Sparkle ${SPARKLE_VERSION}\nSource commit ${SPARKLE_COMMIT}\nhttps://github.com/sparkle-project/Sparkle/tree/${SPARKLE_COMMIT}\nLocal adaptations: custom bundle identity, HTTPS-only transport, no profiling, controlled progress and installation gate.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await buildMacUpdater();
