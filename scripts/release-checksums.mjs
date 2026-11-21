import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const verify = process.argv[2] === '--verify';
const directory = process.argv[verify ? 3 : 2] || 'release-assets';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const expected = ['windows', 'macos', 'linux'].flatMap(platform => ['x64', 'arm64'].map(arch =>
  `PutioManager-${version}-${platform}-${arch}.${platform === 'windows' ? 'zip' : 'tar.gz'}`)).sort();
const manifest = 'SHA256SUMS.txt';
const entries = (await readdir(directory)).filter(name => name !== manifest).sort();
if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error('The release must contain exactly the six expected native archives.');
const lines = [];
for (const name of expected) {
  const hash = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
  lines.push(`${hash}  ${name}`);
}
const text = `${lines.join('\n')}\n`;
if (verify) {
  if (await readFile(path.join(directory, manifest), 'utf8') !== text) throw new Error('Release checksum verification failed.');
  console.log('Verified all six native archive checksums.');
} else {
  await writeFile(path.join(directory, manifest), text, { flag: 'wx' });
  console.log('Wrote checksums for all six native archives.');
}
