import { spawn } from 'node:child_process';
import path from 'node:path';

const platform = process.platform;
if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
const bundle = path.join('release', `PutioManager-${platform}-${process.arch}`);
const executable = platform === 'win32'
  ? path.join(bundle, 'PutioManager.exe')
  : platform === 'darwin'
    ? path.join(bundle, 'PutioManager.app', 'Contents', 'MacOS', 'PutioManager')
    : path.join(bundle, 'PutioManager');
const child = spawn(path.resolve(executable), ['--smoke-test'], { stdio: 'inherit' });
const timeout = setTimeout(() => { child.kill(); }, 90000);
child.on('error', error => { clearTimeout(timeout); console.error('Packaged application failed to start:', error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { clearTimeout(timeout); if (code !== 0) { console.error(`Packaged smoke failed (exit ${code}, signal ${signal}).`); process.exitCode = 1; } });
