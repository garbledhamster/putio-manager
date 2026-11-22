import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DesktopUpdateFailure } from "./update-errors";
import { updateResponse, validUpdateUrl, type UpdateFetch } from "./update-release";
import type { VerifiedUpdateAsset } from "./update-types";

export async function verifyUpdateFile(filename: string, asset: VerifiedUpdateAsset, signal?: AbortSignal): Promise<void> {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.bytes) throw new DesktopUpdateFailure("download-invalid");
  const hash = createHash("sha256");
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new DesktopUpdateFailure("download-invalid");
    for await (const chunk of handle.createReadStream({ signal, autoClose: false })) hash.update(chunk);
  } finally { await handle.close(); }
  const after = await fs.lstat(filename);
  if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || hash.digest("hex") !== asset.sha256) throw new DesktopUpdateFailure("download-invalid");
}
export async function privateUpdateDirectory(userDataDirectory: string, prefix: string): Promise<string> {
  if (!path.isAbsolute(userDataDirectory) || !/^[a-z]+-$/.test(prefix)) throw new DesktopUpdateFailure("storage-unavailable");
  const root = path.join(userDataDirectory, "desktop-updates");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) throw new DesktopUpdateFailure("permission-required");
  const directory = await fs.mkdtemp(path.join(root, prefix));
  await fs.chmod(directory, 0o700);
  return directory;
}
/** Stream only the exact authenticated release asset into a newly created private directory. */
export async function downloadUpdateAsset(asset: VerifiedUpdateAsset, directory: string, signal: AbortSignal, progress: (percent: number) => void, fetcher?: UpdateFetch): Promise<string> {
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(asset.sha256) || !validUpdateUrl(asset.url)) throw new DesktopUpdateFailure("release-invalid");
  const dir = await fs.lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new DesktopUpdateFailure("permission-required");
  const space = await fs.statfs(directory);
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isSafeInteger(available) || available < asset.bytes + 128 * 1024 ** 2) throw new DesktopUpdateFailure("storage-unavailable");
  const filename = path.join(directory, "verified-update.msi");
  const canonicalDirectory = await fs.realpath(directory), parentPath = path.dirname(directory), parent = await fs.lstat(parentPath);
  const handle = await fs.open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  let successful = false;
  try {
    const response = await updateResponse(asset.url, signal, fetcher);
    const declared = response.headers.get("content-length");
    if (!response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.bytes))) { await response.body?.cancel().catch(() => {}); throw new DesktopUpdateFailure("download-invalid"); }
    const reader = response.body.getReader(), hash = createHash("sha256");
    let received = 0;
    try {
      while (true) {
        if (signal.aborted) throw new DesktopUpdateFailure("installer-cancelled");
        const chunk = await reader.read(); if (chunk.done) break;
        if (received + chunk.value.byteLength > asset.bytes) throw new DesktopUpdateFailure("download-invalid");
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const result = await handle.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (!result.bytesWritten) throw new DesktopUpdateFailure("storage-unavailable");
          offset += result.bytesWritten;
        }
        received += chunk.value.byteLength; hash.update(chunk.value);
        progress(Math.min(99, received / asset.bytes * 100));
      }
    } finally { await reader.cancel().catch(() => {}); }
    await handle.sync();
    if (received !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new DesktopUpdateFailure("download-invalid");
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size !== asset.bytes) throw new DesktopUpdateFailure("download-invalid");
    successful = true; progress(100); return filename;
  } finally {
    const owned = !successful ? await handle.stat().catch(() => undefined) : undefined;
    await handle.close();
    if (!successful && owned?.isFile() && owned.nlink === 1) {
      try {
        const [currentDirectory, currentParent, currentFile] = await Promise.all([fs.lstat(directory), fs.lstat(parentPath), fs.lstat(filename)]);
        const currentIdentity = currentFile.isFile() && !currentFile.isSymbolicLink() && currentFile.nlink === 1 && currentFile.dev === owned.dev && currentFile.ino === owned.ino && currentFile.size === owned.size && currentFile.mtimeMs === owned.mtimeMs && currentFile.ctimeMs === owned.ctimeMs;
        const ownedDirectory = currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink() && currentDirectory.dev === dir.dev && currentDirectory.ino === dir.ino && currentParent.isDirectory() && !currentParent.isSymbolicLink() && currentParent.dev === parent.dev && currentParent.ino === parent.ino && await fs.realpath(directory) === canonicalDirectory;
        if (currentIdentity && ownedDirectory) {
          const finalDirectory = await fs.lstat(directory), finalParent = await fs.lstat(parentPath);
          if (finalDirectory.isDirectory() && !finalDirectory.isSymbolicLink() && finalDirectory.dev === dir.dev && finalDirectory.ino === dir.ino && finalParent.isDirectory() && !finalParent.isSymbolicLink() && finalParent.dev === parent.dev && finalParent.ino === parent.ino) await fs.unlink(filename);
        }
      } catch { /* A foreign/substituted path is never cleanup authority. */ }
    }
  }
}
