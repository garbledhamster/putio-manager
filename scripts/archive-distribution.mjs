import { execFileSync } from 'node:child_process';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const labels = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const platform = process.platform, arch = process.arch;
if (!labels[platform] || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported native build host.');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a stable numeric release version.');
const bundle = `PutioManager-${platform}-${arch}-distribution`;
const distribution = path.resolve('release', bundle);
if (!(await lstat(distribution)).isDirectory()) throw new Error('Native distribution is missing.');
await mkdir('release-assets', { recursive: true });
const extension = platform === 'win32' ? 'zip' : 'tar.gz';
const filename = `PutioManager-${version}-${labels[platform]}-${arch}.${extension}`;
const archive = path.resolve('release-assets', filename);
try { await lstat(archive); throw new Error('Release archive already exists. Use a clean output directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (platform === 'win32') {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath ${quote(distribution)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal`], { stdio: 'inherit' });
} else {
  // tar preserves launcher/runtime executable bits on macOS and Linux.
  execFileSync('tar', ['-czf', archive, '-C', path.resolve('release'), bundle], { stdio: 'inherit' });
}
console.log(`Created ${filename}.`);
