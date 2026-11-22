import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRelease } from '../verify-public-release.mjs';

export async function auditAppImage(filename) {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Extract AppImages only on a disposable native CI runner.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'appimage-audit-'));
  try {
    // Read the SquashFS payload with an archive tool; never execute a release ELF.
    const bytes = await readFile(filename);
    let offset = -1, next = 0;
    while ((next = bytes.indexOf(Buffer.from('hsqs'), next)) !== -1) {
      const check = spawnSync('unsquashfs', ['-s', '-o', String(next), path.resolve(filename)], { stdio: 'ignore', shell: false });
      if (check.status === 0) { offset = next; break; }
      next++;
    }
    if (offset < 0) throw new Error('AppImage has no valid SquashFS payload.');
    const result = spawnSync('unsquashfs', ['-d', path.join(directory, 'squashfs-root'), '-o', String(offset), path.resolve(filename)], { stdio: 'ignore', shell: false });
    if (result.status !== 0) throw new Error('Could not extract AppImage.');
    const root = path.join(directory, 'squashfs-root');
    const desktopFiles = (await readdir(root)).filter(name => name.endsWith('.desktop'));
    if (desktopFiles.length !== 1) throw new Error('AppImage desktop identity is ambiguous.');
    const launcher = await readFile(path.join(root, desktopFiles[0]), 'utf8');
    if (!launcher.includes('--enable-sandbox') || launcher.includes('--no-sandbox')) throw new Error('AppImage launch does not preserve the sandbox.');
    const receipt = await verifyRelease('appimage', root, { platform: 'linux' });
    if (!receipt.ok) throw new Error('AppImage payload audit failed.');
    return receipt;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await auditAppImage(process.argv[2]);
