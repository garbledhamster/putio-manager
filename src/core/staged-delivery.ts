import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ensureSafeDirectory } from "./downloads";

export interface ArtifactIdentity { dev: string; ino: string; anchor?: { namespace?: string; name: string } }
export interface OwnedArtifact { root: string; name: string; owned?: ArtifactIdentity; anchorNamespace?: string; allowMissingMain?: boolean }
export interface ContentEvidence { length: number; sha256: string }
export type ArtifactRole = "stage" | "destination" | "anchor-directory";
export class ArtifactCloseUncertain extends Error {
  constructor(readonly role: ArtifactRole, cause: unknown, readonly handle: fs.FileHandle, readonly settlement?: Promise<void>) { super(`Could not safely close ${role} artifact.`, { cause }); }
}
export type CloseAdapter = (handle: fs.FileHandle, role: ArtifactRole) => { attempt: Promise<void>; settlement?: Promise<void> };
export type OnUncertainClose = (role: ArtifactRole, handle: fs.FileHandle, settlement?: Promise<void>) => void;
const unclaimedUncertainHandles = new Set<fs.FileHandle>();
export async function closeArtifact(handle: fs.FileHandle, role: ArtifactRole, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<void> {
  let settlement: Promise<void> | undefined;
  try {
    const close = adapter ? adapter(handle, role) : { attempt: handle.close() };
    settlement = close.settlement; if (settlement) void settlement.catch(() => {}); await close.attempt;
  } catch (error) {
    if (onUncertain) onUncertain(role, handle, settlement);
    else { unclaimedUncertainHandles.add(handle); if (settlement) void settlement.then(() => unclaimedUncertainHandles.delete(handle), () => {}); }
    throw new ArtifactCloseUncertain(role, error, handle, settlement);
  }
}

/** Create or validate this engine's private namespace without following a substituted directory. */
export async function stageNamespace(root: string, namespace: string, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<string> {
  if (!path.isAbsolute(root) || !/^\.putio-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(namespace)) throw new Error("Unsafe staging namespace.");
  await ensureSafeDirectory(root, root, false);
  const directory = path.join(root, namespace);
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await ensureSafeDirectory(root, directory, false);
  const stat = await fs.lstat(directory);
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Staging namespace is not private to this engine user.");
  await syncAnchorDirectory(root, onUncertain, adapter);
  return directory;
}

function artifactPath(artifact: OwnedArtifact): string {
  if (!path.isAbsolute(artifact.root) || !/^\.putio-[0-9a-f-]+\.download$/i.test(artifact.name)) throw new Error("Unsafe staging artifact.");
  return path.join(artifact.root, artifact.name);
}
function matches(stat: Awaited<ReturnType<fs.FileHandle["stat"]>>, identity: ArtifactIdentity): boolean {
  return stat.isFile() && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
}
function anchorPath(artifact: OwnedArtifact): string {
  const anchor = artifact.owned?.anchor;
  if (!anchor || !/^\.putio-[0-9a-f-]+\.download\.anchor$/i.test(anchor.name) || anchor.name !== `${artifact.name}.anchor` || (anchor.namespace !== undefined && !/^\.putio-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(anchor.namespace))) throw new Error("Staging artifact ownership is unknown.");
  return path.join(artifact.root, ...(anchor.namespace ? [anchor.namespace] : []), anchor.name);
}
async function validateAnchorDirectory(root: string, directory: string): Promise<void> {
  await ensureSafeDirectory(root, directory, false);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw new Error("Unsafe staging anchor directory.");
}
export async function syncAnchorDirectory(directory: string, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<"synced" | "not-supported"> {
  const handle = await fs.open(directory, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("Unsafe staging anchor directory.");
    try { await handle.sync(); return "synced"; }
    catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return "not-supported"; throw error; }
  } finally { await closeArtifact(handle, "anchor-directory", onUncertain, adapter); }
}
export async function verifyArtifactAnchor(artifact: OwnedArtifact): Promise<void> {
  if (!artifact.owned) throw new Error("Staging artifact ownership is unknown.");
  const anchor = anchorPath(artifact), directory = path.dirname(anchor);
  await validateAnchorDirectory(artifact.root, directory);
  const stat = await fs.lstat(anchor, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new Error("Staging artifact ownership is unknown."); throw error; });
  if (stat.isSymbolicLink() || !matches(stat, artifact.owned)) throw new Error("Unsafe staging anchor.");
}
export async function createArtifactAnchor(root: string, name: string, handle: fs.FileHandle, namespace?: string, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<ArtifactIdentity> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile()) throw new Error("Unsafe staging artifact.");
  const identity: ArtifactIdentity = { dev: String(stat.dev), ino: String(stat.ino), anchor: { ...(namespace ? { namespace } : {}), name: `${name}.anchor` } };
  const artifact = { root, name, owned: identity }; const anchor = anchorPath(artifact), directory = path.dirname(anchor);
  await validateAnchorDirectory(root, directory);
  await fs.link(artifactPath(artifact), anchor);
  await verifyArtifactAnchor(artifact);
  const main = await fs.lstat(artifactPath(artifact), { bigint: true }); const opened = await handle.stat({ bigint: true });
  if (main.isSymbolicLink() || !matches(main, identity) || !matches(opened, identity)) throw new Error("Unsafe staging artifact.");
  await handle.sync(); await syncAnchorDirectory(directory, onUncertain, adapter);
  return identity;
}
/** Only call after a durable release intent; never adopt or modify the main pathname here. */
export async function releaseArtifactAnchor(artifact: OwnedArtifact, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<void> {
  const anchor = anchorPath(artifact), directory = path.dirname(anchor);
  await validateAnchorDirectory(artifact.root, directory);
  const stat = await fs.lstat(anchor, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) { await syncAnchorDirectory(directory, onUncertain, adapter); return; }
  if (!artifact.owned || stat.isSymbolicLink() || !matches(stat, artifact.owned)) throw new Error("Unsafe staging anchor.");
  await fs.unlink(anchor); await syncAnchorDirectory(directory, onUncertain, adapter);
}
async function checkedOpen(artifact: OwnedArtifact, role: ArtifactRole, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<fs.FileHandle> {
  if (!artifact.owned) throw new Error("Staging artifact ownership is unknown.");
  await verifyArtifactAnchor(artifact);
  const file = artifactPath(artifact);
  await ensureSafeDirectory(artifact.root, artifact.root, false);
  const before = await fs.lstat(file, { bigint: true });
  if (before.isSymbolicLink() || !matches(before, artifact.owned)) throw new Error("Unsafe staging artifact.");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!matches(await handle.stat({ bigint: true }), artifact.owned)) throw new Error("Unsafe staging artifact.");
    return handle;
  } catch (error) { await closeArtifact(handle, role, onUncertain, adapter); throw error; }
}
async function confirm(artifact: OwnedArtifact, handle: fs.FileHandle, length: number): Promise<void> {
  if (!artifact.owned) throw new Error("Staging artifact ownership is unknown.");
  await verifyArtifactAnchor(artifact);
  await ensureSafeDirectory(artifact.root, artifact.root, false);
  const current = await fs.lstat(artifactPath(artifact), { bigint: true });
  const opened = await handle.stat({ bigint: true });
  if (current.isSymbolicLink() || !matches(current, artifact.owned) || !matches(opened, artifact.owned) || Number(current.size) !== length || Number(opened.size) !== length) throw new Error("Unsafe staging artifact.");
}

/** Hash an owned regular file using bounded reads and verify its pathname and open handle still match. */
export async function hashArtifact(artifact: OwnedArtifact, signal: AbortSignal, role: ArtifactRole = "stage", onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<ContentEvidence> {
  const handle = await checkedOpen(artifact, role, onUncertain, adapter);
  try {
    const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let length = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); length += bytesRead;
    }
    signal.throwIfAborted(); await confirm(artifact, handle, length);
    return { length, sha256: hash.digest("hex") };
  } finally { await closeArtifact(handle, role, onUncertain, adapter); }
}

/** Delete only an exact owned regular file. Missing owned files reconcile idempotently. */
export async function removeArtifact(artifact: OwnedArtifact, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<void> {
  if (!artifact.owned) throw new Error("Staging artifact ownership is unknown.");
  await verifyArtifactAnchor(artifact);
  const file = artifactPath(artifact);
  await ensureSafeDirectory(artifact.root, artifact.root, false);
  const stat = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return;
  if (stat.isSymbolicLink() || !matches(stat, artifact.owned)) throw new Error("Unsafe staging artifact.");
  await fs.unlink(file); await syncAnchorDirectory(artifact.root, onUncertain, adapter);
}

/** Copy an already verified stage into a new destination-owned file. The owner persists identity before writes. */
export async function copyArtifact(source: OwnedArtifact, target: OwnedArtifact, evidence: ContentEvidence, signal: AbortSignal, own: (identity: ArtifactIdentity) => Promise<void>, progress: (bytes: number) => void | Promise<void>, onUncertain?: OnUncertainClose, adapter?: CloseAdapter): Promise<ArtifactIdentity> {
  if (!Number.isSafeInteger(evidence.length) || evidence.length < 0 || !/^[0-9a-f]{64}$/i.test(evidence.sha256)) throw new Error("Invalid stage evidence.");
  const input = await checkedOpen(source, "stage", onUncertain, adapter);
  let output: fs.FileHandle | undefined;
  try {
    await ensureSafeDirectory(target.root, target.root, false);
    output = await fs.open(artifactPath(target), "wx", 0o666);
    const stat = await output.stat({ bigint: true });
    if (target.anchorNamespace) await stageNamespace(target.root, target.anchorNamespace, onUncertain, adapter);
    const identity = await createArtifactAnchor(target.root, target.name, output, target.anchorNamespace, onUncertain, adapter);
    await own(identity); signal.throwIfAborted();
    const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let position = 0;
    while (true) {
      signal.throwIfAborted();
      if (position === evidence.length) {
        const extra = await input.read(buffer, 0, 1, position);
        if (extra.bytesRead) throw new Error("Staging content changed.");
        break;
      }
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, evidence.length - position), position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      for (let written = 0; written < bytesRead;) {
        signal.throwIfAborted();
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error("Could not write destination copy.");
        written += result.bytesWritten;
      }
      position += bytesRead; await progress(position);
    }
    signal.throwIfAborted(); await confirm(source, input, position);
    if (position !== evidence.length || hash.digest("hex") !== evidence.sha256) throw new Error("Staging content changed.");
    await output.sync(); const closing = output; output = undefined; await closeArtifact(closing, "destination", onUncertain, adapter);
    const copied = await hashArtifact({ ...target, owned: identity }, signal, "destination", onUncertain, adapter);
    if (copied.length !== evidence.length || copied.sha256 !== evidence.sha256) throw new Error("Destination copy did not verify.");
    return identity;
  } finally {
    try { if (output) await closeArtifact(output, "destination", onUncertain, adapter); } finally { await closeArtifact(input, "stage", onUncertain, adapter); }
  }
}

/** Account only recorded artifacts; ambiguous or substituted paths block admission. */
export async function retainedStageBytes(root: string, artifacts: OwnedArtifact[]): Promise<number> {
  let total = 0; const counted = new Set<string>();
  for (const artifact of artifacts) {
    const file = artifactPath(artifact);
    const relative = path.relative(root, artifact.root);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Unsafe staging artifact.");
    try { await ensureSafeDirectory(root, artifact.root, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !artifact.owned) continue; throw error; }
    const stat = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat) {
      if (!artifact.owned) continue;
      if (!artifact.allowMissingMain) throw new Error("Owned staging artifact is missing.");
      await verifyArtifactAnchor(artifact);
      const anchor = await fs.lstat(anchorPath(artifact), { bigint: true });
      const key = `${anchor.dev}:${anchor.ino}`; if (counted.has(key)) continue; counted.add(key);
      const bytes = Number(anchor.size);
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(total + bytes)) throw new Error("Could not account for staging storage.");
      total += bytes; continue;
    }
    if (!artifact.owned || stat.isSymbolicLink() || !matches(stat, artifact.owned)) throw new Error("Unsafe staging artifact.");
    await verifyArtifactAnchor(artifact);
    const key = `${stat.dev}:${stat.ino}`; if (counted.has(key)) continue; counted.add(key);
    const bytes = Number(stat.size);
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(total + bytes)) throw new Error("Could not account for staging storage.");
    total += bytes;
  }
  return total;
}

async function storageInformation(root: string): Promise<{ pool: string; available: bigint }> {
  try {
    const stat = await fs.stat(root, { bigint: true }); const free = await fs.statfs(root, { bigint: true });
    if (free.bsize <= 0n || free.bavail < 0n) throw new Error();
    return { pool: String(stat.dev), available: free.bavail * free.bsize };
  } catch { throw new Error("Could not determine available storage."); }
}

/** Serializes storage admission so simultaneous downloads cannot promise the same space. */
export class StageReservations {
  private pending = new Map<string, { root: string; pool: string; kind: "stage" | "destination"; bytes: number; minimumFree: number }>();
  private serial: Promise<unknown> = Promise.resolve();
  async reserve(id: string, root: string, additional: number, retained: () => Promise<number>, maximum: number, minimumFree: number): Promise<void> {
    const operation = this.serial.catch(() => {}).then(async () => {
      if (!Number.isSafeInteger(additional) || additional < 0 || !Number.isSafeInteger(maximum) || maximum <= 0 || !Number.isSafeInteger(minimumFree) || minimumFree < 0) throw new Error("Invalid staging storage policy.");
      await ensureSafeDirectory(root, root, false);
      const total = await retained();
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("Could not account for staging storage.");
      const { pool, available } = await storageInformation(root);
      const others = [...this.pending.entries()].filter(([key]) => key !== id).map(([, item]) => item);
      const stagePending = others.filter(item => item.kind === "stage" && item.root === root).reduce((sum, item) => sum + BigInt(item.bytes), 0n);
      const poolItems = others.filter(item => item.pool === pool);
      const poolPending = poolItems.reduce((sum, item) => sum + BigInt(item.bytes), 0n);
      const requiredFree = poolItems.reduce((max, item) => Math.max(max, item.minimumFree), minimumFree);
      if (BigInt(total) + stagePending + BigInt(additional) > BigInt(maximum) || available < poolPending + BigInt(additional) + BigInt(requiredFree)) throw new Error("Insufficient staging capacity or free-space reserve.");
      this.pending.set(id, { root, pool, kind: "stage", bytes: additional, minimumFree });
    });
    this.serial = operation;
    await operation;
  }
  async reserveDestination(id: string, root: string, additional: number, minimumFree: number): Promise<void> {
    const operation = this.serial.catch(() => {}).then(async () => {
      if (!Number.isSafeInteger(additional) || additional < 0 || !Number.isSafeInteger(minimumFree) || minimumFree < 0) throw new Error("Invalid destination storage policy.");
      await ensureSafeDirectory(root, root, false);
      const { pool, available } = await storageInformation(root);
      const others = [...this.pending.entries()].filter(([key, item]) => key !== id && item.pool === pool).map(([, item]) => item);
      const pending = others.reduce((sum, item) => sum + BigInt(item.bytes), 0n);
      const requiredFree = others.reduce((max, item) => Math.max(max, item.minimumFree), minimumFree);
      if (available < pending + BigInt(additional) + BigInt(requiredFree)) throw new Error("Insufficient destination capacity or free-space reserve.");
      this.pending.set(id, { root, pool, kind: "destination", bytes: additional, minimumFree });
    });
    this.serial = operation; await operation;
  }
  async consume(id: string, bytes: number): Promise<void> {
    const operation = this.serial.catch(() => {}).then(() => {
      const existing = this.pending.get(id);
      if (!existing || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > existing.bytes) throw new Error("Invalid staging reservation.");
      existing.bytes -= bytes;
    });
    this.serial = operation; await operation;
  }
  async release(id: string): Promise<void> {
    const operation = this.serial.catch(() => {}).then(() => { this.pending.delete(id); });
    this.serial = operation; await operation;
  }
}
