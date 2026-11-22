import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CHECKSUM_NAME, inspectReleaseAssets } from './release-catalog.mjs';

const args = process.argv.slice(2), verify = args[0] === '--verify';
if (verify) args.shift();
const directory = args.shift() || 'release-assets', stage = args.shift() || 'build';
if (args.length) throw new Error('Unexpected checksum arguments.');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const assets = await inspectReleaseAssets(directory, version, stage);
const text = `${assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n')}\n`;
const manifest = path.join(directory, CHECKSUM_NAME);
if (verify) {
  const stat = await lstat(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || await readFile(manifest, 'utf8') !== text) throw new Error('Release checksum verification failed.');
  console.log(`Verified all ${assets.length} ${stage} release checksums.`);
} else {
  await writeFile(manifest, text, { flag: 'wx' });
  console.log(`Wrote all ${assets.length} ${stage} release checksums.`);
}
