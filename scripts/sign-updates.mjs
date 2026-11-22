import { createPrivateKey, createPublicKey, sign, verify, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectReleaseAssets, stableVersion } from './release-catalog.mjs';

function matchingKeys(privateInput, publicInput) {
  const privateKey = typeof privateInput === 'string' || Buffer.isBuffer(privateInput) ? createPrivateKey(privateInput) : privateInput;
  const publicKey = typeof publicInput === 'string' || Buffer.isBuffer(publicInput) ? createPublicKey(publicInput) : publicInput;
  if (privateKey?.asymmetricKeyType !== 'ed25519' || publicKey?.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required.');
  const actual = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const expected = publicKey.export({ type: 'spki', format: 'der' });
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('The signing key does not match the application public key.');
  return { privateKey, publicKey };
}
export function canonicalUpdateMetadata(version, assets) {
  stableVersion(version);
  const sorted = assets.map(({ name, bytes, sha256, ed25519 }) => ({ name, bytes, sha256, ...(ed25519 === undefined ? {} : { ed25519 }) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(sorted.map(asset => asset.name)).size !== sorted.length || sorted.some(asset => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256))) throw new Error('Invalid signed update asset inventory.');
  for (const asset of sorted) {
    const mac = /^PutioManager-.*-macos-(x64|arm64)-update\.zip$/.test(asset.name);
    if ((mac || asset.ed25519 !== undefined) && (!mac || !validArchiveSignature(asset.ed25519))) throw new Error('Invalid signed archive binding.');
  }
  return Buffer.from(`${JSON.stringify({ schema: 1, version, assets: sorted })}\n`, 'utf8');
}
function validArchiveSignature(value) { return typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, 'base64').length === 64 && Buffer.from(value, 'base64').toString('base64') === value; }
export function macAppcast(version, arch, bytes, signature) {
  stableVersion(version);
  if (!['x64', 'arm64'].includes(arch) || !Number.isSafeInteger(bytes) || bytes < 1 || !validArchiveSignature(signature)) throw new Error('Invalid appcast inputs.');
  const name = `PutioManager-${version}-macos-${arch}-update.zip`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Putio Manager updates</title><item><title>Putio Manager ${version}</title><sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="https://github.com/garbledhamster/putio-manager/releases/download/v${version}/${name}" length="${bytes}" type="application/octet-stream" sparkle:os="macos" sparkle:edSignature="${signature}" /></item></channel></rss>\n`;
}
export async function signUpdates(directory, version, privateInput, publicInput) {
  const { privateKey, publicKey } = matchingKeys(privateInput, publicInput);
  const assets = await inspectReleaseAssets(directory, version, 'build');
  const archiveSignatures = new Map();
  for (const arch of ['x64', 'arm64']) {
    const asset = assets.find(value => value.name === `PutioManager-${version}-macos-${arch}-update.zip`);
    const raw = await readFile(path.join(directory, asset.name));
    const signature = sign(null, raw, privateKey);
    if (!verify(null, raw, publicKey, signature)) throw new Error('Archive signature verification failed.');
    archiveSignatures.set(asset.name, signature.toString('base64'));
    await writeFile(path.join(directory, `appcast-${arch}.xml`), macAppcast(version, arch, raw.length, signature.toString('base64')), { flag: 'wx' });
  }
  const signedAssets = await inspectReleaseAssets(directory, version, 'signing');
  const bytes = canonicalUpdateMetadata(version, signedAssets.map(asset => archiveSignatures.has(asset.name) ? { ...asset, ed25519: archiveSignatures.get(asset.name) } : asset)), signature = sign(null, bytes, privateKey);
  if (!verify(null, bytes, publicKey, signature)) throw new Error('Update signature verification failed.');
  const manifest = `PutioManager-${version}-updates.json`;
  await writeFile(path.join(directory, manifest), bytes, { flag: 'wx' });
  await writeFile(path.join(directory, `${manifest}.sig`), `${signature.toString('base64')}\n`, { flag: 'wx' });
  await inspectReleaseAssets(directory, version, 'published');
  return { manifest, signature: `${manifest}.sig` };
}
export async function verifySignedUpdates(directory, version, publicInput) {
  const publicKey = typeof publicInput === 'string' || Buffer.isBuffer(publicInput) ? createPublicKey(publicInput) : publicInput;
  if (publicKey?.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 public key is required.');
  const assets = await inspectReleaseAssets(directory, version, 'published');
  const filename = `PutioManager-${version}-updates.json`, bytes = await readFile(path.join(directory, filename));
  const text = (await readFile(path.join(directory, `${filename}.sig`), 'utf8')).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text) || !verify(null, bytes, publicKey, Buffer.from(text, 'base64'))) throw new Error('Update signature verification failed.');
  const archiveSignatures = new Map();
  for (const arch of ['x64', 'arm64']) {
    const archive = await readFile(path.join(directory, `PutioManager-${version}-macos-${arch}-update.zip`));
    const appcast = await readFile(path.join(directory, `appcast-${arch}.xml`), 'utf8');
    const signature = /sparkle:edSignature="([A-Za-z0-9+/]{86}==)"/.exec(appcast)?.[1];
    if (!signature || appcast !== macAppcast(version, arch, archive.length, signature) || !verify(null, archive, publicKey, Buffer.from(signature, 'base64'))) throw new Error('Archive signature verification failed.');
    archiveSignatures.set(`PutioManager-${version}-macos-${arch}-update.zip`, signature);
  }
  const expected = canonicalUpdateMetadata(version, assets.filter(asset => ![filename, `${filename}.sig`].includes(asset.name)).map(asset => archiveSignatures.has(asset.name) ? { ...asset, ed25519: archiveSignatures.get(asset.name) } : asset));
  if (!bytes.equals(expected)) throw new Error('Signed update content does not match the publication inventory.');
  return true;
}
async function main() {
  const args = process.argv.slice(2), verifyOnly = args[0] === '--verify';
  if (verifyOnly) args.shift();
  if (args.length > 1) throw new Error('Invalid signing arguments.');
  const directory = args[0] || 'release-assets';
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const { UPDATE_PUBLIC_KEY_PEM } = await import(pathToFileURL(path.resolve('src/desktop/update-public-key.ts')).href);
  if (!UPDATE_PUBLIC_KEY_PEM) throw new Error('Application update public key is not configured.');
  if (verifyOnly) await verifySignedUpdates(directory, version, UPDATE_PUBLIC_KEY_PEM);
  else {
    const privateKey = process.env.PUTIO_UPDATE_SIGNING_KEY;
    delete process.env.PUTIO_UPDATE_SIGNING_KEY;
    if (!privateKey || !privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('PKCS8 update signing key is not configured.');
    await signUpdates(directory, version, privateKey, UPDATE_PUBLIC_KEY_PEM);
    await verifySignedUpdates(directory, version, UPDATE_PUBLIC_KEY_PEM);
  }
  console.log(verifyOnly ? 'Verified exact signed publication metadata and Mac archives.' : 'Signed and verified exact update metadata and Mac archives.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Update signing verification failed. No private values were printed.'); process.exitCode = 1; });
