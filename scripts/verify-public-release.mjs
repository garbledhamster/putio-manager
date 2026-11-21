#!/usr/bin/env node
// Inspect release inputs without printing the values that triggered a finding.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const sourceRoots = new Set(['src', 'scripts', 'tests', 'docs', '.github']);
const sourceFiles = new Set(['.gitattributes', '.gitignore', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.ui.json']);
const generatedRoots = new Set(['.git', 'node_modules', 'dist', 'release', 'release-assets']);
const distributionRoots = new Set(['desktop', 'headless']);
const distributionFiles = new Set(['node', 'node.exe', 'launch', 'launch.cmd', 'launch.cjs', 'README.md', 'LICENSE-PutioManager.txt', 'LICENSE-Node.txt', 'NODE-PROVENANCE.txt']);
const galleryPath = /^docs\/images\/\d{2}-[a-z0-9-]+\.png$/;
const privateSegments = /^(?:\.git|project-context|protected-backups|\.ssh|\.aws|\.codex|\.obsidian|\.smart-env|user-?data|private-profile|runtime-state)$/i;
const privateNames = /^(?:\.env(?:\..*)?|\.npmrc|\.DS_Store|id_(?:rsa|ed25519)|client-token|credential-key|server-config\.json|settings\.json|engine-state\.json|cookies|login data|local state|preferences)$/i;
const textExtension = /\.(?:[cm]?js|[cm]?ts|json|html?|css|md|txt|xml|config|settings|ya?ml|svg|sh|cmd|ps1|cjs|mts|map)$/i;
const maximumExpandedBytes = 2 * 1024 ** 3;

function safeName(name) {
  return String(name).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 240);
}

function checkedName(name) {
  const normalized = name.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) throw new Error('unsafe archive path');
  return normalized.replace(/\/$/, '');
}

function checkLink(name, target) {
  if (!target || target.startsWith('/') || /^[a-z]:/i.test(target)) throw new Error('unsafe archive link');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target.replaceAll('\\', '/')));
  if (resolved === '..' || resolved.startsWith('../')) throw new Error('unsafe archive link');
}

function isAuthored(name, mode) {
  if (mode === 'source') return true;
  return name.startsWith('headless/') || /(?:^|\/)resources\/app(?:\.asar)?\//i.test(name) || /(?:^|\/)Resources\/app(?:\.asar)?\//.test(name) || distributionFiles.has(name);
}

function inspectGalleryPng(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('invalid gallery PNG');
  let offset = 8, first = true, ended = false, metadata = false;
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset), type = data.subarray(offset + 4, offset + 8).toString('ascii');
    if (offset + 12 + size > data.length || (first && (type !== 'IHDR' || size !== 13))) throw new Error('invalid gallery PNG chunk');
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) metadata = true;
    offset += 12 + size; first = false;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== data.length) throw new Error('invalid gallery PNG termination');
  return metadata;
}

async function directoryEntries(root, mode) {
  const entries = [];
  async function visit(relative) {
    const dir = path.join(root, relative);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (mode === 'source' && !relative && generatedRoots.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(path.join(root, name));
        checkLink(name, target);
        entries.push({ name, link: true, target });
      } else if (entry.isDirectory()) {
        entries.push({ name, directory: true });
        // Do not read an accidentally included private profile or credential directory.
        if (!privateSegments.test(entry.name)) await visit(name);
      } else if (entry.isFile()) entries.push({ name, filename: path.join(root, name) });
      else throw new Error('unsupported filesystem entry');
    }
  }
  await visit('');
  return entries;
}

function tarEntries(buffer) {
  const entries = [];
  let offset = 0, pax = {}, longName;
  const string = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const storedChecksum = Number.parseInt(string(header, 148, 8).trim(), 8);
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (storedChecksum !== checksum) throw new Error('invalid tar checksum');
    const size = Number.parseInt(string(header, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumExpandedBytes || offset + 512 + size > buffer.length) throw new Error('invalid tar entry size');
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = string(header, 156, 1);
    if (type === 'x' || type === 'g') {
      for (const record of data.toString('utf8').split('\n')) {
        const match = /^\d+ ([^=]+)=(.*)$/.exec(record);
        if (match) pax[match[1]] = match[2];
      }
      continue;
    }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    const prefix = string(header, 345, 155);
    const name = checkedName(pax.path || longName || `${prefix ? `${prefix}/` : ''}${string(header, 0, 100)}`);
    if (type === '2' || type === '1') {
      const target = pax.linkpath || string(header, 157, 100);
      checkLink(name, target);
      entries.push({ name, link: true, target });
    } else if (type === '5') entries.push({ name, directory: true });
    else if (type === '' || type === '0') entries.push({ name, data });
    else throw new Error('unsupported tar entry');
    pax = {}; longName = undefined;
  }
  return entries;
}

function zipEntries(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('unsupported zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16), expanded = 0;
  if (count === 65535 || offset === 0xffffffff) throw new Error('ZIP64 is not supported');
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('invalid zip directory');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameSize = buffer.readUInt16LE(offset + 28), extraSize = buffer.readUInt16LE(offset + 30), commentSize = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const originalName = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    const name = checkedName(originalName);
    expanded += size;
    if ((flags & 1) || ![0, 8].includes(method) || expanded > maximumExpandedBytes) throw new Error('unsupported zip entry');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('invalid zip local entry');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressedSize > buffer.length) throw new Error('invalid zip entry size');
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) : raw;
    if (data.length !== size) throw new Error('invalid zip expanded size');
    const unixMode = buffer.readUInt32LE(offset + 38) >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      const target = data.toString('utf8');
      checkLink(name, target);
      entries.push({ name, link: true, target });
    } else entries.push({ name, data, directory: originalName.endsWith('/') });
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return entries;
}

function stripContainer(entries) {
  const first = entries[0]?.name.split('/')[0];
  if (first && !distributionRoots.has(first) && !distributionFiles.has(first) && entries.every(entry => entry.name === first || entry.name.startsWith(`${first}/`))) {
    return entries.filter(entry => entry.name !== first).map(entry => ({ ...entry, name: entry.name.slice(first.length + 1) }));
  }
  return entries;
}

function asarEntries(buffer, parent) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 4) throw new Error('invalid asar header');
  const headerSize = buffer.readUInt32LE(4), jsonSize = buffer.readUInt32LE(12), base = 8 + headerSize;
  if (16 + jsonSize > base || base > buffer.length) throw new Error('invalid asar header size');
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'));
  const entries = [];
  function visit(files, prefix = '') {
    for (const [segment, entry] of Object.entries(files)) {
      const name = checkedName(`${prefix}${segment}`);
      if (entry.files) visit(entry.files, `${name}/`);
      else if (entry.link) checkLink(name, entry.link);
      else if (!entry.unpacked) {
        const start = base + Number(entry.offset), size = entry.size;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < base || size < 0 || start + size > buffer.length) throw new Error('invalid asar entry size');
        entries.push({ name: `${parent}/${name}`, data: buffer.subarray(start, start + size) });
      }
    }
  }
  if (!header.files || typeof header.files !== 'object') throw new Error('invalid asar file tree');
  visit(header.files);
  return entries;
}

export async function verifyRelease(mode, target, options = {}) {
  if (!['source', 'artifact'].includes(mode)) throw new Error('use source or artifact mode');
  const denylist = options.privateTerms || [];
  if (!Array.isArray(denylist) || denylist.some(value => typeof value !== 'string' || value.length < 3)) throw new Error('private denylist must contain strings of at least three characters');
  const findings = [];
  const add = (name, category, line) => {
    let reportedName = safeName(name);
    for (const term of denylist) reportedName = reportedName.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '[redacted]');
    const item = { path: reportedName, category, ...(line ? { line } : {}) };
    if (!findings.some(value => JSON.stringify(value) === JSON.stringify(item))) findings.push(item);
  };
  const root = path.resolve(target);
  const stat = await fs.lstat(root);
  let entries;
  if (stat.isDirectory()) entries = await directoryEntries(root, mode);
  else if (mode === 'artifact' && stat.isFile()) {
    const raw = await fs.readFile(root);
    if (/\.zip$/i.test(root)) entries = zipEntries(raw);
    else if (/\.(?:tar\.gz|tgz)$/i.test(root)) entries = tarEntries(gunzipSync(raw, { maxOutputLength: maximumExpandedBytes }));
    else if (/\.tar$/i.test(root)) entries = tarEntries(raw);
    else throw new Error('artifact must be an expanded distribution, .zip, .tar, or .tar.gz');
    entries = stripContainer(entries);
  } else throw new Error('invalid inspection target');
  let files = 0, bytes = 0;
  async function inspect(entry) {
    const { name } = entry;
    const segments = name.split('/'), top = segments[0];
    const forbidden = segments.some(part => privateSegments.test(part)) || privateNames.test(segments.at(-1)) || /^docs\/(?:agents|superpowers)(?:\/|$)/i.test(name);
    if (forbidden) { add(name, 'private-runtime-or-operator-file'); return; }
    if (mode === 'source' && !sourceRoots.has(top) && !sourceFiles.has(name)) add(name, 'unexpected-source-input');
    const galleryEntry = ['docs', 'docs/images'].includes(name) || galleryPath.test(name);
    if (mode === 'artifact' && !distributionRoots.has(top) && !distributionFiles.has(name) && !galleryEntry) add(name, 'unexpected-distribution-input');
    if (entry.link) {
      checkLink(name, entry.target);
      if (mode === 'source') add(name, 'source-symbolic-link');
      for (const term of denylist) if (`${name}/${entry.target}`.toLowerCase().includes(term.toLowerCase())) add(name, 'private-denylist-path');
      return;
    }
    if (entry.directory) return;
    const data = entry.data || await fs.readFile(entry.filename);
    files++; bytes += data.length;
    if (bytes > maximumExpandedBytes) throw new Error('expanded inspection limit exceeded');
    if (galleryPath.test(name) && inspectGalleryPng(data)) add(name, 'gallery-image-metadata');
    const ascii = data.toString('latin1');
    const lowerAscii = denylist.length ? ascii.toLowerCase() : '';
    const lowerWide = denylist.length ? data.toString('utf16le').toLowerCase() : '';
    for (const term of denylist) {
      if (lowerAscii.includes(Buffer.from(term).toString('latin1').toLowerCase()) || lowerWide.includes(term.toLowerCase())) add(name, 'private-denylist-match');
      if (name.toLowerCase().includes(term.toLowerCase())) add(name, 'private-denylist-path');
    }
    // Match whole credentials, not coincidental prefixes inside larger vendor data.
    if (/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_])/.test(ascii)) add(name, 'credential-token-shape');
    if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}-----END/.test(ascii)) add(name, 'private-key-content');
    if (/\.asar$/i.test(name)) {
      for (const child of asarEntries(data, name)) await inspect(child);
      return;
    }
    if (!isAuthored(name, mode) || (!textExtension.test(name) && !['LICENSE', 'NOTICE'].includes(segments.at(-1))) || data.includes(0)) return;
    const lines = data.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/(?<![\d.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?![\d.])/.test(line)) add(name, 'private-network-address', index + 1);
      const homes = line.match(/(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|\/(?:Users|home)\/[^/\s"'<>]+)/g) || [];
      if (homes.some(value => !/[/\\](?:example|demo|test|user|putio|runner|runneradmin|public|default|USERNAME)$/i.test(value))) add(name, 'personal-home-path', index + 1);
      const literal = /(?:access[_-]?token|api[_-]?key|password|oauth[_-]?token|putio[_-]?token|client[_-]?secret|token)["']?\s*[=:]\s*["']([A-Za-z0-9_+\/-]{16,})["']/ig;
      for (const match of line.matchAll(literal)) if (!/(?:fixture|synthetic|test|fake|example|demo|placeholder)/i.test(match[1])) add(name, 'credential-literal', index + 1);
    }
    const text = lines.join('\n');
    if (/(?:name|Name)=["'][^"']*token[^"']*["'][^>]*>[\s\S]{0,300}?<(?:value|Value)>\s*[A-Za-z0-9_+\/-]{16,}\s*<\/(?:value|Value)>/i.test(text)) add(name, 'credential-default-setting');
    if (/\.map$/i.test(name) && /"sourcesContent"\s*:/.test(text)) add(name, 'embedded-source-map');
  }
  for (const entry of entries) await inspect(entry);
  const names = new Set(entries.map(entry => entry.name));
  const required = mode === 'source' ? ['LICENSE', 'package.json'] : ['README.md', 'LICENSE-PutioManager.txt', 'LICENSE-Node.txt', 'launch.cjs'];
  for (const name of required) if (!names.has(name)) add(name, 'required-release-file-missing');
  if (mode === 'artifact') {
    if (!names.has('node') && !names.has('node.exe')) add('node', 'bundled-runtime-missing');
    for (const prefix of ['desktop/', 'headless/']) if (!entries.some(entry => entry.name.startsWith(prefix))) add(prefix, 'distribution-component-missing');
  }
  return { ok: findings.length === 0, mode, files, bytes, findings };
}

async function main() {
  const args = process.argv.slice(2), mode = args.shift();
  const target = args[0] && !args[0].startsWith('--') ? args.shift() : '.';
  let privateTerms = [];
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--private-denylist') throw new Error('unknown option');
    const content = await fs.readFile(args[1], 'utf8');
    privateTerms = content.trim().startsWith('[') ? JSON.parse(content) : content.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  }
  const result = await verifyRelease(mode, target, { privateTerms });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

const comparablePath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
if (process.argv[1] && comparablePath(process.argv[1]) === comparablePath(fileURLToPath(import.meta.url))) {
  main().catch(() => { console.error('Privacy verification could not complete. Check the mode, input format, and archive integrity. No matched values were printed.'); process.exitCode = 1; });
}
