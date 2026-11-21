import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

for (const root of ['src/ui', 'dist/ui']) {
  const css = await readFile(path.join(root, 'heroicons.css'), 'utf8');
  const registry = await readFile(path.join(root, root.startsWith('src') ? 'icons.ts' : 'icons.js'), 'utf8');
  const assets = [...css.matchAll(/url\(['"]?([^)'" ]+)/g)].map(match => match[1]);
  if (!assets.length || assets.some(url => !/^\.\/heroicons\/[a-z0-9-]+\.svg$/.test(url))) throw new Error(`${root}: invalid or external icon URL`);
  for (const asset of new Set(assets)) await access(path.join(root, asset));
  const classes = new Set([...css.matchAll(/\.ui-icon--([a-z0-9-]+)/g)].map(match => match[1]));
  const entries = [...registry.matchAll(/"[^"]+":\s*"([a-z0-9-]+)"/g)].map(match => match[1]);
  if (!entries.length || entries.some(name => !classes.has(name))) throw new Error(`${root}: registry references missing CSS classes`);
  await access(path.join(root, 'heroicons/LICENSE'));
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  if (!html.includes('heroicons.css') || /(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) throw new Error(`${root}: stylesheet missing or external runtime asset`);
}
console.log('Bundled Heroicons registry and offline asset references verified.');

for (const root of ['src/ui/branding', 'dist/ui/branding']) {
  const png = await readFile(path.join(root, 'putio-manager.png'));
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png[25] !== 6) throw new Error(`${root}: source icon must be an RGBA PNG`);
  const ico = await readFile(path.join(root, 'putio-manager.ico'));
  if (ico.readUInt32LE(0) !== 0x00010000) throw new Error(`${root}: invalid Windows icon`);
  const count = ico.readUInt16LE(4); const sizes = Array.from({length: count}, (_, index) => ico[6 + index * 16] || 256);
  if (![16, 24, 32, 48, 64, 128, 256].every(size => sizes.includes(size))) throw new Error(`${root}: Windows icon sizes missing`);
  for (let index = 0; index < count; index++) {
    const offset = ico.readUInt32LE(6 + index * 16 + 12);
    if (ico.toString('hex', offset, offset + 8) !== '89504e470d0a1a0a' || ico[offset + 25] !== 6) throw new Error(`${root}: Windows icon entry lacks RGBA transparency`);
  }
  const icns = await readFile(path.join(root, 'putio-manager.icns'));
  if (icns.toString('ascii', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) throw new Error(`${root}: invalid macOS icon`);
  const macTypes = new Set<string>();
  for (let offset = 8; offset < icns.length;) {
    const type = icns.toString('ascii', offset, offset + 4), length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) throw new Error(`${root}: invalid macOS icon entry`);
    if (type !== 'TOC ') { if (icns.toString('hex', offset + 8, offset + 16) !== '89504e470d0a1a0a' || icns[offset + 33] !== 6) throw new Error(`${root}: macOS icon entry lacks RGBA transparency`); macTypes.add(type); }
    offset += length;
  }
  if (!['ic07','ic08','ic09','ic10','ic11','ic12'].every(type => macTypes.has(type))) throw new Error(`${root}: macOS icon sizes missing`);
  for (const size of [16,32]) { const small = await readFile(path.join(root, `putio-manager-${size}.png`)); if (small.readUInt32BE(16) !== size || small.readUInt32BE(20) !== size || small[25] !== 6) throw new Error(`${root}: invalid ${size} pixel PNG`); }
}
console.log('Application icon source, native formats and small PNGs verified.');
