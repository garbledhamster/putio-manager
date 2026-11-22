import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIX_SOURCE = Object.freeze({
  name: 'PutioManager-WiX-6.0.2-source.tar.gz', version: '6.0.2',
  commit: 'b3f340393117094a75ea8ced77f2357e4aa095e7',
  url: 'https://codeload.github.com/wixtoolset/wix/tar.gz/b3f340393117094a75ea8ced77f2357e4aa095e7',
  bytes: 9863733,
  sha256: '9490a024f2da5140605b87d8a9415e54029f4f2a5d4c7820fdd064a2ee80dd30',
});
export const CHECKSUM_NAME = 'SHA256SUMS.txt';
export function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid stable release version.');
  const fields = version.split('.').map(Number);
  if (fields.some((value, index) => !Number.isSafeInteger(value) || value > [255, 255, 65535][index])) throw new Error('Release version exceeds installer version limits.');
  return version;
}
export function releaseAssetNames(version, stage = 'build') {
  stableVersion(version);
  if (!['build', 'signing', 'published'].includes(stage)) throw new Error('Unknown release inventory stage.');
  const names = ['windows', 'macos', 'linux'].flatMap(platform => ['x64', 'arm64'].map(arch =>
    `PutioManager-${version}-${platform}-${arch}.${platform === 'windows' ? 'zip' : 'tar.gz'}`));
  for (const arch of ['x64', 'arm64']) names.push(
    `PutioManager-${version}-windows-${arch}-setup.exe`, `PutioManager-${version}-windows-${arch}-setup.msi`,
    `PutioManager-${version}-macos-${arch}-update.zip`, `PutioManager-${version}-linux-${arch}.AppImage`);
  names.push('latest-linux.yml', 'latest-linux-arm64.yml', WIX_SOURCE.name);
  if (stage !== 'build') names.push('appcast-x64.xml', 'appcast-arm64.xml');
  if (stage === 'published') names.push(`PutioManager-${version}-updates.json`, `PutioManager-${version}-updates.json.sig`);
  return names.sort();
}
export async function hashReleaseFile(filename) {
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 2n * 1024n ** 3n) throw new Error('Invalid release file.');
  const handle = await open(filename, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Release file changed during inspection.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(filename, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || named.ino !== opened.ino || named.dev !== opened.dev) throw new Error('Release file changed during inspection.');
    return { bytes: Number(after.size), sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
export async function inspectReleaseAssets(directory, version, stage = 'build') {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid release inventory directory.');
  const expected = releaseAssetNames(version, stage);
  const actual = (await readdir(directory)).filter(name => name !== CHECKSUM_NAME).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Release inventory is incomplete or contains unexpected files.');
  const records = [];
  for (const name of expected) records.push({ name, ...await hashReleaseFile(path.join(directory, name)) });
  return records;
}
export async function fetchWixSource(directory) {
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, WIX_SOURCE.name);
  const response = await fetch(WIX_SOURCE.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('Pinned installer source download failed.');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > WIX_SOURCE.bytes) throw new Error('Pinned installer source length mismatch.'); chunks.push(chunk); }
  const data = Buffer.concat(chunks);
  if (bytes !== WIX_SOURCE.bytes || createHash('sha256').update(data).digest('hex') !== WIX_SOURCE.sha256) throw new Error('Pinned installer source checksum mismatch.');
  await writeFile(destination, data, { flag: 'wx' });
}
async function main() {
  const [command, directory = 'release-assets', stage = 'build'] = process.argv.slice(2);
  if (command === 'fetch-wix-source') { await fetchWixSource(directory); console.log('Verified pinned installer corresponding source.'); return; }
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (command === 'list') { for (const name of releaseAssetNames(version, stage)) console.log(name); return; }
  if (command !== 'verify') throw new Error('Use list, verify, or fetch-wix-source.');
  const records = await inspectReleaseAssets(directory, version, stage);
  const source = records.find(asset => asset.name === WIX_SOURCE.name);
  if (source.bytes !== WIX_SOURCE.bytes || source.sha256 !== WIX_SOURCE.sha256) throw new Error('Pinned installer source checksum mismatch.');
  console.log(`Verified ${records.length} release assets against the ${stage} inventory.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Release catalog verification failed. No private values were printed.'); process.exitCode = 1; });
