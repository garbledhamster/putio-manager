import path from 'node:path';
if (process.platform === 'win32') {
  const { stageWindowsUpdateRuntime } = await import('./windows-installer/build.mjs');
  await stageWindowsUpdateRuntime(path.resolve(`release/PutioManager-win32-${process.arch}`));
} else if (process.platform === 'darwin') {
  const { stageMacUpdater } = await import('./macos-updater/package.mjs');
  await stageMacUpdater(path.resolve(`release/PutioManager-darwin-${process.arch}`));
}
