import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { DownloadJob, RemoteFile } from "../shared";
import { safeName } from "./rules";
import { PutioRequestError } from "./api";
export interface DownloadRuntime { now: () => number; random: () => number; delay: (ms: number, signal?: AbortSignal) => Promise<void> }
export const downloadProcessInstance = randomUUID();
export interface DownloadSource { url: string; file: RemoteFile; expectedBytes?: number; crc32?: string; sha1?: string; zipId?: string; zipContentsVerified?: boolean }
export interface StagingDelivery { root: string; rootDev: string; rootIno: string; namespace: string; name: string; maxBytes: number; minimumFreeBytes: number; phase: "downloading-stage" | "stage-ready" | "copying" | "destination-prepared" | "published" | "stage-cleanup-pending"; owned?: import("./staged-delivery").ArtifactIdentity; stageAnchorRelease?: "pending" | "released"; destinationAnchorRelease?: "pending" | "released"; retiredDestinations?: { name: string; owned: import("./staged-delivery").ArtifactIdentity; release?: "pending" | "released" }[]; length?: number; sha256?: string; verification?: "verified" | "unverified"; zipContentsVerified?: boolean }
export interface DownloadRecovery { delivery?: StagingDelivery; version: 1; intent: "run" | "paused" | "canceled"; kind: "file" | "zip"; partial: string; closeUncertainProcess?: string; retryCount?: number; retryAt?: string; owned?: import("./staged-delivery").ArtifactIdentity; source?: { id: string; kind: "file" | "zip"; expectedBytes?: number; crc32?: string; sha1?: string; updatedAt?: string; folderSize?: number; sourceIsFolder?: boolean; etag?: string; encoding?: string; zipId?: string }; finalization?: { phase: "prepared" | "published"; length: number; sha256: string; dev: string; ino: string; verification: "verified" | "unverified" }; cleanup?: { phase: "not-started" | "in-flight" | "succeeded" | "failed" | "unknown"; step: "file" | "folder" } }
export async function recoverPublished(job: DownloadJob, root: string, recovery: DownloadRecovery, onUncertain?: import("./staged-delivery").OnUncertainClose, closeAdapter?: import("./staged-delivery").CloseAdapter): Promise<void> {
  const evidence = recovery.finalization;
  if (!evidence) return;
  const dir = path.dirname(job.destination);
  try {
    if (!/^\.putio-[0-9a-f-]+\.download$/i.test(recovery.partial)) throw new Error();
    await ensureSafeDirectory(root, dir, false);
    if (recovery.delivery) {
      if (!recovery.owned || recovery.owned.dev !== evidence.dev || recovery.owned.ino !== evidence.ino) throw new Error();
      const { verifyArtifactAnchor } = await import("./staged-delivery.js");
      await verifyArtifactAnchor({ root: dir, name: recovery.partial, owned: recovery.owned });
    }
    const stat = await fs.lstat(job.destination, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || String(stat.dev) !== evidence.dev || String(stat.ino) !== evidence.ino || Number(stat.size) !== evidence.length) throw new Error();
    const handle = await fs.open(job.destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || String(opened.dev) !== evidence.dev || String(opened.ino) !== evidence.ino || Number(opened.size) !== evidence.length) throw new Error();
      const digest = createHash("sha256"), sha1 = createHash("sha1"); let crc = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) { digest.update(chunk); sha1.update(chunk); crc = crc32(chunk, crc); }
      const after = await handle.stat({ bigint: true });
      const current = await fs.lstat(job.destination, { bigint: true });
      await ensureSafeDirectory(root, dir, false);
      if (recovery.delivery) { const { verifyArtifactAnchor } = await import("./staged-delivery.js"); await verifyArtifactAnchor({ root: dir, name: recovery.partial, owned: recovery.owned }); }
      const source = recovery.source;
      if (!current.isFile() || current.isSymbolicLink() || String(current.dev) !== evidence.dev || String(current.ino) !== evidence.ino || String(after.dev) !== evidence.dev || String(after.ino) !== evidence.ino || Number(current.size) !== evidence.length || Number(after.size) !== evidence.length || digest.digest("hex") !== evidence.sha256 ||
        (source?.expectedBytes !== undefined && (!Number.isSafeInteger(source.expectedBytes) || source.expectedBytes < 0 || source.expectedBytes !== evidence.length)) ||
        (source?.sha1 !== undefined && (!/^[0-9a-f]{40}$/i.test(source.sha1) || sha1.digest("hex") !== source.sha1.toLowerCase())) ||
        (source?.crc32 !== undefined && (!/^[0-9a-f]{8}$/i.test(source.crc32) || crc.toString(16).padStart(8, "0") !== source.crc32.toLowerCase())) ||
        (evidence.verification === "verified" && source && source.expectedBytes === undefined)) throw new Error();
    } finally {
      if (recovery.delivery) { const { closeArtifact } = await import("./staged-delivery.js"); await closeArtifact(handle, "destination", onUncertain, closeAdapter); }
      else await handle.close();
    }
    job.verification = evidence.verification; job.status = evidence.verification === "verified" ? "completed" : "unverified";
    if (!job.deleteAfterDownload) job.cleanupStatus = "not-required";
    else {
      const phase = recovery.cleanup?.phase;
      job.cleanupStatus = phase === "succeeded" || phase === "failed" || phase === "not-started" ? phase : "unknown";
      if (phase === "in-flight") recovery.cleanup!.phase = "unknown";
      job.cleanupWarning = job.cleanupStatus === "succeeded" ? undefined : "Source cleanup was not resumed after restart.";
    }
    job.completedAt = new Date().toISOString(); job.error = undefined; job.speed = 0;
    const partial = path.join(dir, recovery.partial);
    const partialStat = await fs.lstat(partial, { bigint: true }).catch(() => undefined);
    if (partialStat?.isFile() && !partialStat.isSymbolicLink() && String(partialStat.dev) === evidence.dev && String(partialStat.ino) === evidence.ino) {
      await fs.unlink(partial);
      if (recovery.delivery) await (await import("./staged-delivery.js")).syncAnchorDirectory(dir, onUncertain, closeAdapter);
    }
  } catch { job.status = "needs-attention"; job.error = "Published destination could not be verified."; job.speed = 0; }
}
export async function discardOwnedPartial(job: DownloadJob, root: string, record: DownloadRecovery, onUncertain?: import("./staged-delivery").OnUncertainClose, adapter?: import("./staged-delivery").CloseAdapter): Promise<void> {
  if (!record.owned && !record.delivery) return;
  if (!/^\.putio-[0-9a-f-]+\.download$/i.test(record.partial)) throw new Error("Unsafe partial.");
  const dir = path.dirname(job.destination);
  try { await ensureSafeDirectory(root, dir, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !record.owned && record.delivery) return; throw error; }
  const partial = path.join(dir, record.partial);
  if (record.delivery && !record.owned) {
    const anchor = path.join(dir, record.delivery.namespace, `${record.partial}.anchor`);
    const planned = await fs.lstat(anchor).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (planned) throw new Error("Destination artifact ownership is unknown.");
  }
  if (record.delivery && record.owned) {
    const { verifyArtifactAnchor } = await import("./staged-delivery.js");
    await verifyArtifactAnchor({ root: dir, name: record.partial, owned: record.owned });
  }
  const st = await fs.lstat(partial, { bigint: true }).catch((error: any) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (st) {
    if (!record.owned || !st.isFile() || st.isSymbolicLink() || String(st.dev) !== record.owned.dev || String(st.ino) !== record.owned.ino) throw new Error("Unsafe partial.");
    await fs.unlink(partial);
    if (record.delivery) await (await import("./staged-delivery.js")).syncAnchorDirectory(dir, onUncertain, adapter);
  }
  if (!record.delivery) delete record.owned;
}
export async function discardOwnedStage(record: DownloadRecovery, onUncertain?: import("./staged-delivery").OnUncertainClose, adapter?: import("./staged-delivery").CloseAdapter): Promise<void> {
  const stage = record.delivery;
  if (!stage) return;
  if (!path.isAbsolute(stage.root) || !/^\.putio-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stage.namespace) || !/^\.putio-[0-9a-f-]+\.download$/i.test(stage.name)) throw new Error("Unsafe staging artifact.");
  const directory = path.join(stage.root, stage.namespace);
  await ensureSafeDirectory(stage.root, stage.root, false);
  const rootStat = await fs.lstat(stage.root, { bigint: true });
  if (String(rootStat.dev) !== stage.rootDev || String(rootStat.ino) !== stage.rootIno) throw new Error("Unsafe staging root.");
  try { await ensureSafeDirectory(stage.root, directory, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !stage.owned) return; throw error; }
  const file = path.join(directory, stage.name);
  const current = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stage.owned) {
    const anchor = await fs.lstat(`${file}.anchor`).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (anchor) throw new Error("Staging artifact ownership is unknown.");
  }
  if (current && !stage.owned) throw new Error("Staging artifact ownership is unknown.");
  if (stage.owned) { const { removeArtifact } = await import("./staged-delivery.js"); await removeArtifact({ root: directory, name: stage.name, owned: stage.owned }, onUncertain, adapter); }
}
/** A stage reference can be released after its verified output has been published. */
export async function releaseStageAnchor(record: DownloadRecovery, persist: () => Promise<void>, onUncertain?: import("./staged-delivery").OnUncertainClose, adapter?: import("./staged-delivery").CloseAdapter): Promise<void> {
  const stage = record.delivery; if (!stage?.owned) return;
  if (!stage.stageAnchorRelease) stage.stageAnchorRelease = "pending";
  await persist();
  const { releaseArtifactAnchor } = await import("./staged-delivery.js");
  await releaseArtifactAnchor({ root: path.join(stage.root, stage.namespace), name: stage.name, owned: stage.owned }, onUncertain, adapter);
  stage.stageAnchorRelease = "released"; await persist();
}
/** Persist destination tombstones before releasing anchors; tombstoned destinations never resume artifact work. */
export async function releaseStagedAnchors(job: DownloadJob, record: DownloadRecovery, persist: () => Promise<void>, onUncertain?: import("./staged-delivery").OnUncertainClose, adapter?: import("./staged-delivery").CloseAdapter): Promise<void> {
  const stage = record.delivery; if (!stage) return;
  await releaseStageAnchor(record, persist, onUncertain, adapter);
  if (record.owned && !stage.destinationAnchorRelease) stage.destinationAnchorRelease = "pending";
  for (const retired of stage.retiredDestinations ?? []) retired.release ??= "pending";
  await persist();
  const { releaseArtifactAnchor } = await import("./staged-delivery.js");
  if (record.owned) {
    await releaseArtifactAnchor({ root: path.dirname(job.destination), name: record.partial, owned: record.owned }, onUncertain, adapter);
    stage.destinationAnchorRelease = "released"; await persist();
  }
  for (const retired of stage.retiredDestinations ?? []) {
    await releaseArtifactAnchor({ root: path.dirname(job.destination), name: retired.name, owned: retired.owned }, onUncertain, adapter);
    retired.release = "released"; await persist();
  }
}
class InvalidDownloadResponse extends Error {}
class TemporaryDownloadError extends Error { constructor(readonly retryAfterMs = 0) { super("Temporary CDN failure."); } }
type Source = (signal: AbortSignal) => Promise<string | DownloadSource>;
type SourceIdentity = (signal: AbortSignal) => Promise<RemoteFile>;
export function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function samePath(a: string, b: string): boolean { return pathIdentity(a) === pathIdentity(b); }
export async function ensureSafeDirectory(root: string, dir: string, createMissing = true) {
  const relative = path.relative(root, dir);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Download directory is outside its selected root.");
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !samePath(await fs.realpath(root), root))
    throw new Error("Unsafe download root.");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Unsafe download directory.");
    } catch (error: any) {
      if (error.code !== "ENOENT" || !createMissing) throw error;
      try {
        await fs.mkdir(current);
      } catch (mkdirError: any) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Unsafe download directory.");
    }
  }
}
export class DownloadQueue {
  jobs: DownloadJob[] = [];
  recovery: Record<string, DownloadRecovery> = {};
  paused = false;
  private active = new Map<string, AbortController>();
  private publishing = new Set<string>();
  private uncertainCloses = new Set<string>();
  private uncertainHandles = new Map<fs.FileHandle, { jobId: string; settled: boolean }>();
  hasUncertainOpen(): boolean { return this.uncertainHandles.size > 0; }
  async waitUntilInactive(jobId: string): Promise<void> { while (this.active.has(jobId)) await new Promise(resolve => setTimeout(resolve, 10)); }
  retainUncertain(jobId: string, handle: fs.FileHandle, settlement?: Promise<void>) {
    if (this.uncertainHandles.has(handle)) return;
    const entry = { jobId, settled: false }; this.uncertainHandles.set(handle, entry); this.uncertainCloses.add(jobId);
    this.recovery[jobId].closeUncertainProcess = downloadProcessInstance;
    if (settlement) void settlement.then(() => { entry.settled = true; }, () => {});
  }
  async retainCloseError(jobId: string, error: unknown): Promise<boolean> {
    const { ArtifactCloseUncertain } = await import("./staged-delivery.js");
    if (!(error instanceof ArtifactCloseUncertain)) return false;
    this.retainUncertain(jobId, error.handle, error.settlement); return true;
  }
  private closeTracker(jobId: string): import("./staged-delivery").OnUncertainClose { return (_role, handle, settlement) => this.retainUncertain(jobId, handle, settlement); }
  async reconcileSettledCloses(): Promise<void> {
    const jobs = new Set<string>();
    for (const [handle, entry] of this.uncertainHandles) if (entry.settled) { this.uncertainHandles.delete(handle); jobs.add(entry.jobId); }
    for (const jobId of jobs) if (![...this.uncertainHandles.values()].some(entry => entry.jobId === jobId)) {
      this.uncertainCloses.delete(jobId);
      if (this.recovery[jobId]?.closeUncertainProcess === downloadProcessInstance) delete this.recovery[jobId].closeUncertainProcess;
    }
    if (jobs.size) { await this.changed(); await this.flush(); }
  }
  private sources = new Map<string, Source>();
  private sourceIdentities = new Map<string, SourceIdentity>();
  private cleanup = new Map<string, () => Promise<void | boolean>>();
  private roots = new Map<string, string>();
  private kinds = new Map<string, "file" | "zip">();
  private stopping = false;
  private wake?: AbortController;
  private wakeGeneration = 0;
  private runtime: DownloadRuntime;
  private cancelWrites: Promise<void> = Promise.resolve();
  private stageReservations?: Promise<import("./staged-delivery").StageReservations>;
  private aggregateNext = 0;
  private aggregateRate = 0;
  constructor(
    private concurrency: () => number,
    private changed: () => void | Promise<void>,
    private transport: typeof fetch = fetch,
    private flush: () => Promise<void> = async () => {},
    private globalRate: () => number = () => 0,
    private options: { runtime?: DownloadRuntime; stagingLimits?: () => { maxBytes: number; minimumFreeBytes: number }; stagedCloseAdapter?: import("./staged-delivery").CloseAdapter } = {},
  ) { this.runtime = options.runtime ?? { now: Date.now, random: Math.random, delay: (ms, signal) => delay(ms, undefined, { signal }) }; }
  async enqueue(
    file: RemoteFile,
    dir: string,
    source: Source,
    cleanup?: () => Promise<void | boolean>,
    rootDirectory: string = dir,
    jobId?: string,
    options: { deleteAfterDownload?: boolean; deleteSourceFolders?: boolean; speedLimitBytesPerSecond?: number; staging?: { root: string; rootDev?: string; rootIno?: string; namespace: string; maxBytes: number; minimumFreeBytes: number } } = {},
    trustedCanonicalRoot?: string,
    allowNewAfterCompletion = false,
    kind: "file" | "zip" = "file",
    shouldAccept: () => boolean = () => true,
    sourceIdentity?: SourceIdentity,
  ): Promise<string> {
    if (!path.isAbsolute(dir))
      throw new Error("Choose an absolute download directory.");
    if (!path.isAbsolute(rootDirectory))
      throw new Error("Choose an absolute download directory.");
    const relative = path.relative(rootDirectory, dir);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Download directory is outside its selected root.");
    const canonicalRoot = await fs.realpath(rootDirectory);
    if (trustedCanonicalRoot !== undefined && !samePath(canonicalRoot, trustedCanonicalRoot)) throw new Error("Unsafe download root.");
    await ensureSafeDirectory(canonicalRoot, canonicalRoot);
    if (!shouldAccept()) return "";
    const destination = path.join(canonicalRoot, relative, safeName(file.name));
    const existingJob = this.jobs.find(
      (j) => j.fileId === file.id && j.destination === destination && (this.kinds.get(j.id) ?? "file") === kind &&
        !(allowNewAfterCompletion && ["completed", "unverified", "canceled"].includes(j.status)),
    );
    if (existingJob) return existingJob.id;
    const job: DownloadJob = {
      id: jobId ?? randomUUID(),
      fileId: file.id,
      name: file.name,
      destination,
      status: "queued",
      bytesReceived: 0,
      totalBytes: file.size,
      totalKnown: file.sizeKnown !== false,
      speed: 0,
      addedAt: new Date().toISOString(),
      deleteAfterDownload: options.deleteAfterDownload, deleteSourceFolders: options.deleteSourceFolders, speedLimitBytesPerSecond: options.speedLimitBytesPerSecond,
    };
    let staged: StagingDelivery | undefined;
    if (options.staging) {
      await ensureSafeDirectory(options.staging.root, options.staging.root, false);
      const st = await fs.lstat(options.staging.root, { bigint: true });
      const rootDev = String(st.dev), rootIno = String(st.ino);
      if ((options.staging.rootDev !== undefined && options.staging.rootDev !== rootDev) || (options.staging.rootIno !== undefined && options.staging.rootIno !== rootIno)) throw new Error("Unsafe staging root.");
      staged = { ...options.staging, rootDev, rootIno, name: `.putio-${randomUUID()}.download`, phase: "downloading-stage" };
    }
    if (!shouldAccept()) return "";
    this.jobs.push(job);
    this.recovery[job.id] = { version: 1, intent: "run", kind, partial: `.putio-${randomUUID()}.download`, ...(staged ? { delivery: staged } : {}) };
    this.kinds.set(job.id, kind);
    this.sources.set(job.id, source);
    if (sourceIdentity) this.sourceIdentities.set(job.id, sourceIdentity);
    this.roots.set(job.id, canonicalRoot);
    if (cleanup) this.cleanup.set(job.id, cleanup);
    this.changed();
    this.pump();
    return job.id;
  }
  restore(job: DownloadJob, root: string, source: Source, cleanup?: () => Promise<void | boolean>, kind: "file" | "zip" = "file", sourceIdentity?: SourceIdentity) {
    this.jobs.push(job);
    this.kinds.set(job.id, kind);
    if (this.recovery[job.id]?.delivery) this.roots.set(job.id, root);
    if (["queued", "paused", "waiting"].includes(job.status)) {
      this.roots.set(job.id, root);
      this.sources.set(job.id, source);
      if (sourceIdentity) this.sourceIdentities.set(job.id, sourceIdentity);
      if (cleanup) this.cleanup.set(job.id, cleanup);
    }
  }
  async retry(id: string, source: Source, cleanup?: () => Promise<void | boolean>, root?: string, sourceIdentity?: SourceIdentity) {
    await this.reconcileSettledCloses();
    const job = this.jobs.find(item => item.id === id);
    if (!job || this.uncertainCloses.has(id) || this.recovery[id]?.closeUncertainProcess !== undefined) throw new Error("Job cannot be retried.");
    if (["queued", "downloading", "copying", "recovering", "finalizing", "cleaning", "restarting"].includes(job.status)) return;
    if (!["failed", "canceled", "interrupted", "needs-attention", "waiting"].includes(job.status)) throw new Error("Job cannot be retried.");
    this.wakeGeneration++; this.wake?.abort(); this.wake = undefined;
    job.attemptCount = 0; job.retryAt = undefined;
    if (this.recovery[id]) { this.recovery[id].retryCount = 0; delete this.recovery[id].retryAt; }
    if (root) this.roots.set(id, root);
    if (job.error === "Source changed; retry to accept the refreshed source.") {
      const prior = this.recovery[id];
      if (prior?.owned && !prior.delivery && root && /^\.putio-[0-9a-f-]+\.download$/i.test(prior.partial)) {
        const dir = path.dirname(job.destination); await ensureSafeDirectory(root, dir, false);
        const partial = path.join(dir, prior.partial); const st = await fs.lstat(partial, { bigint: true }).catch((error: any) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (st) {
          if (!st.isFile() || st.isSymbolicLink() || String(st.dev) !== prior.owned.dev || String(st.ino) !== prior.owned.ino) throw new Error("Unsafe partial.");
          await fs.unlink(partial);
        }
      }
      const staged = prior?.delivery;
      if (staged) {
        if (!root) throw new Error("Destination root is unavailable.");
        const released = staged.stageAnchorRelease || staged.destinationAnchorRelease || staged.retiredDestinations?.some(item => item.release);
        if (released) {
          if ((staged.owned && staged.stageAnchorRelease !== "released") || (prior.owned && staged.destinationAnchorRelease !== "released") || staged.retiredDestinations?.some(item => item.release !== "released")) throw new Error("Staging anchor cleanup requires attention.");
        } else {
          await discardOwnedPartial(job, root, prior, this.closeTracker(job.id), this.options.stagedCloseAdapter); await discardOwnedStage(prior, this.closeTracker(job.id), this.options.stagedCloseAdapter);
          await this.changed(); await this.flush();
          await releaseStagedAnchors(job, prior, async () => { await this.changed(); await this.flush(); }, this.closeTracker(job.id), this.options.stagedCloseAdapter);
        }
      }
      this.recovery[id] = { version: 1, intent: "run", kind: this.kinds.get(id) ?? "file", partial: `.putio-${randomUUID()}.download`, ...(staged ? { delivery: { root: staged.root, rootDev: staged.rootDev, rootIno: staged.rootIno, namespace: staged.namespace, name: `.putio-${randomUUID()}.download`, maxBytes: staged.maxBytes, minimumFreeBytes: staged.minimumFreeBytes, phase: "downloading-stage" as const } } : {}) };
    }
    this.recovery[id] ??= { version: 1, intent: "run", kind: this.kinds.get(id) ?? "file", partial: `.putio-${randomUUID()}.download` };
    if (this.recovery[id].intent === "canceled") {
      const record = this.recovery[id];
      if (record.delivery) {
        if (!root || (record.owned && record.delivery.destinationAnchorRelease !== "released") || (record.delivery.owned && record.delivery.stageAnchorRelease !== "released") || record.delivery.retiredDestinations?.some(item => item.release !== "released")) throw new Error("Canceled artifacts could not be safely removed.");
        if (!record.owned && !record.delivery.owned) { await discardOwnedPartial(job, root, record, this.closeTracker(job.id), this.options.stagedCloseAdapter); await discardOwnedStage(record, this.closeTracker(job.id), this.options.stagedCloseAdapter); }
        delete record.owned; delete record.delivery.owned; delete record.delivery.stageAnchorRelease; delete record.delivery.destinationAnchorRelease; delete record.delivery.retiredDestinations;
        record.partial = `.putio-${randomUUID()}.download`;
        record.delivery.name = `.putio-${randomUUID()}.download`; record.delivery.phase = "downloading-stage";
        delete record.delivery.length; delete record.delivery.sha256; delete record.delivery.verification; delete record.delivery.zipContentsVerified; delete record.finalization;
      }
      record.intent = "run";
    }
    this.sources.set(id, source);
    if (sourceIdentity) this.sourceIdentities.set(id, sourceIdentity);
    if (cleanup) this.cleanup.set(id, cleanup);
    job.status = "queued"; job.error = undefined; job.speed = 0;
    await this.changed();
  }
  async pause() {
    this.paused = true;
    this.wakeGeneration++; this.wake?.abort(); this.wake = undefined;
    for (const job of this.jobs) {
      if (["queued", "waiting", "downloading", "copying", "recovering", "restarting", "finalizing", "cleaning"].includes(job.status)) {
        if (job.status === "waiting") job.status = "paused";
        const record = this.recovery[job.id];
        if (record) record.intent = "paused";
      }
    }
    let saveError: unknown;
    try { await this.changed(); await this.flush(); } catch (error) { saveError = error; }
    for (const [id, controller] of this.active) {
      const job = this.jobs.find(item => item.id === id);
      if (job && ["downloading", "copying", "recovering", "restarting"].includes(job.status)) controller.abort();
    }
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 10));
    if (saveError) throw saveError;
    await this.reconcileSettledCloses();
    if (this.hasUncertainOpen()) { await this.changed(); await this.flush(); throw new Error("A staged file could not be safely closed; pause needs attention."); }
    await this.changed(); await this.flush();
  }
  resume() {
    for (const job of this.jobs) {
      if (job.status === "paused") job.status = job.retryAt && this.recovery[job.id]?.retryAt ? "waiting" : "queued";
      if (["queued", "waiting"].includes(job.status) && this.recovery[job.id]?.intent === "paused") this.recovery[job.id].intent = "run";
    }
    this.paused = false;
  }
  cancel(ids?: string[]): Promise<void> {
    const operation = this.cancelWrites.catch(() => {}).then(() => this.cancelJobs(ids));
    this.cancelWrites = operation;
    return operation;
  }
  private async cancelJobs(ids?: string[]) {
    await this.reconcileSettledCloses();
    let changed = false;
    this.wakeGeneration++; this.wake?.abort(); this.wake = undefined;
    const queuedJobs = this.jobs.filter(job => (!ids || ids.includes(job.id)) && ["queued", "waiting"].includes(job.status));
    for (const job of queuedJobs) {
      job.status = "canceled"; if (this.recovery[job.id]) this.recovery[job.id].intent = "canceled"; changed = true;
    }
    const finalizing = this.jobs.filter(job => (!ids || ids.includes(job.id)) && (["finalizing", "cleaning"].includes(job.status) || (job.status === "completed" && this.recovery[job.id]?.cleanup?.step === "folder" && ["not-started", "in-flight"].includes(this.recovery[job.id].cleanup!.phase))) && this.recovery[job.id]?.intent !== "canceled");
    const pendingPublication = finalizing.filter(job => job.status === "finalizing" && !this.publishing.has(job.id));
    for (const job of finalizing) if (this.recovery[job.id]) this.recovery[job.id].intent = "canceled";
    const activeJobs = this.jobs.filter(job => (!ids || ids.includes(job.id)) && ["downloading", "copying", "recovering", "restarting"].includes(job.status));
    for (const job of activeJobs) if (this.recovery[job.id]) this.recovery[job.id].intent = "canceled";
    let saveError: unknown;
    if (activeJobs.length || finalizing.length || changed) { try { await this.changed(); await this.flush(); } catch (error) { saveError = error; } }
    for (const job of activeJobs) this.active.get(job.id)?.abort();
    while ([...activeJobs, ...pendingPublication].some(job => this.active.has(job.id))) await new Promise(resolve => setTimeout(resolve, 10));
    if (saveError) throw saveError;
    if ([...activeJobs, ...pendingPublication].some(job => this.uncertainCloses.has(job.id))) throw new Error("Canceled partial could not be safely removed.");
    for (const job of this.jobs) {
      if (ids && !ids.includes(job.id)) continue;
      const pendingStagedCancel = job.status === "needs-attention" && this.recovery[job.id]?.delivery && this.recovery[job.id]?.intent === "canceled" && !this.recovery[job.id]?.finalization;
      if (job.status === "paused" || pendingStagedCancel || ((activeJobs.includes(job) || queuedJobs.includes(job)) && job.status === "canceled")) {
        const record = this.recovery[job.id];
        if (record) { record.intent = "canceled"; await this.changed(); await this.flush(); }
        if (this.uncertainCloses.has(job.id) || record?.closeUncertainProcess !== undefined) throw new Error("Canceled partial could not be safely removed.");
        const root = this.roots.get(job.id);
        try {
          if (record?.delivery && !root) throw new Error("Destination root is unavailable.");
          if ((record?.owned || record?.delivery) && root) await discardOwnedPartial(job, root, record, this.closeTracker(job.id), this.options.stagedCloseAdapter);
          if (record?.delivery) await discardOwnedStage(record, this.closeTracker(job.id), this.options.stagedCloseAdapter);
        } catch (error) {
          await this.retainCloseError(job.id, error);
          if (record?.delivery) { job.status = "needs-attention"; job.error = "Canceled artifacts could not be safely removed."; job.speed = 0; await this.changed(); await this.flush(); }
          throw error;
        }
        if (queuedJobs.includes(job)) { this.sources.delete(job.id); this.sourceIdentities.delete(job.id); this.roots.delete(job.id); this.cleanup.delete(job.id); }
        job.status = "canceled"; job.bytesReceived = 0; job.speed = 0; job.error = undefined; changed = true;
        if (record?.delivery) {
          try { await this.changed(); await this.flush(); await releaseStagedAnchors(job, record, async () => { await this.changed(); await this.flush(); }, this.closeTracker(job.id), this.options.stagedCloseAdapter); }
          catch (error) { await this.retainCloseError(job.id, error); job.status = "needs-attention"; job.error = "Canceled artifact anchor requires inspection."; await this.changed(); await this.flush(); throw error; }
        }
      } else if (job.status === "queued") {
        job.status = "canceled";
        this.sources.delete(job.id);
        this.sourceIdentities.delete(job.id);
        this.roots.delete(job.id);
        this.cleanup.delete(job.id);
        changed = true;
      } else if (job.status === "downloading") {
        const controller = this.active.get(job.id);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          changed = true;
        }
      }
    }
    if (changed) { await this.changed(); await this.flush(); }
    this.scheduleWake();
  }
  async stopActive() {
    this.wakeGeneration++; this.wake?.abort();
    this.wake = undefined;
    this.paused = true;
    this.stopping = true;
    for (const [id, controller] of this.active) {
      const job = this.jobs.find(item => item.id === id);
      if (job && ["downloading", "copying", "recovering", "restarting"].includes(job.status)) controller.abort();
    }
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 10));
  }
  private scheduleWake() {
    const generation = ++this.wakeGeneration;
    this.wake?.abort(); this.wake = undefined;
    if (this.paused || this.stopping) return;
    const waiting = this.jobs.filter(job => job.status === "waiting" && job.retryAt);
    if (!waiting.length) return;
    const deadline = Math.min(...waiting.map(job => Date.parse(job.retryAt!)));
    const controller = new AbortController(); this.wake = controller;
    void this.runtime.delay(Math.min(2147483647, Math.max(0, deadline - this.runtime.now())), controller.signal).then(async () => {
      if (generation !== this.wakeGeneration || this.paused || this.stopping) return;
      this.wake = undefined;
      if (deadline > this.runtime.now()) { this.scheduleWake(); return; }
      for (const job of waiting) {
        if (generation !== this.wakeGeneration || this.paused || this.stopping) return;
        if (job.status === "waiting" && Date.parse(job.retryAt!) <= this.runtime.now()) {
          job.status = "queued"; job.retryAt = undefined;
          if (this.recovery[job.id]) delete this.recovery[job.id].retryAt;
          try { await this.changed(); await this.flush(); }
          catch {
            if (job.status === "queued" && this.recovery[job.id]?.intent === "run") {
              job.status = "needs-attention"; job.error = "Could not save job state; download did not start.";
              await Promise.resolve(this.changed()).catch(() => {});
            }
            return;
          }
        }
      }
      if (generation !== this.wakeGeneration || this.paused || this.stopping) return;
      this.pump(); this.scheduleWake();
    }).catch(() => {});
  }
  pump() {
    this.scheduleWake();
    const blocked = "Waiting for an unresolved staged file close. Exit the engine if it cannot be reconciled.";
    if (this.hasUncertainOpen()) {
      let changed = false;
      for (const job of this.jobs) if (["queued", "waiting"].includes(job.status) && job.stagingWarning !== blocked) { job.stagingWarning = blocked; changed = true; }
      if (changed) this.changed();
      return;
    }
    for (const job of this.jobs) if (job.stagingWarning === blocked) { delete job.stagingWarning; this.changed(); }
    while (!this.paused && this.active.size < Math.max(1, this.concurrency())) {
      const job = this.jobs.find((j) => j.status === "queued" && !this.active.has(j.id));
      if (!job) break;
      if (this.uncertainCloses.has(job.id) || this.recovery[job.id]?.closeUncertainProcess !== undefined) { job.status = "needs-attention"; job.error = "Download file could not be safely closed."; this.changed(); continue; }
      const controller = new AbortController();
      this.active.set(job.id, controller);
      job.status = (job.attemptCount ?? 0) > 0 ? "recovering" : "downloading";
      void Promise.resolve(this.changed()).then(() => this.flush()).then(() => this.run(job, controller), () => {
        if (this.recovery[job.id]?.intent === "canceled") job.status = "canceled";
        else if (this.paused || this.recovery[job.id]?.intent === "paused") job.status = "paused";
        else { job.status = "needs-attention"; job.error = "Could not save job state; download did not start."; }
      }).finally(() => {
        this.active.delete(job.id);
        this.changed();
        this.pump();
        this.scheduleWake();
      });
    }
  }
  private async fetchHeaders(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const child = new AbortController(), timeout = new AbortController();
    let expired = false;
    const abort = () => child.abort(); signal.addEventListener("abort", abort, { once: true });
    let cancel: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => { cancel = () => reject(new Error("Canceled")); signal.addEventListener("abort", cancel, { once: true }); });
    const request = this.transport(url, { signal: child.signal, headers }).then(response => {
      if (expired || signal.aborted) { void response.body?.cancel(); throw new Error("Canceled"); }
      return response;
    }).catch(error => {
      if (signal.aborted || expired) throw error;
      throw new TemporaryDownloadError();
    });
    try {
      return await Promise.race([request, stopped, this.runtime.delay(30000, timeout.signal).then(() => { expired = true; child.abort(); throw new TemporaryDownloadError(); })]);
    } finally { timeout.abort(); signal.removeEventListener("abort", abort); if (cancel) signal.removeEventListener("abort", cancel); }
  }
  private async run(job: DownloadJob, controller: AbortController) {
    const destinationRoot = this.roots.get(job.id)!;
    const destinationDirectory = path.dirname(job.destination);
    const delivery = this.recovery[job.id]?.delivery;
    let root = destinationRoot, directory = destinationDirectory;
    let temp = path.join(directory, `.putio-${randomUUID()}.download`);
    let handle: fs.FileHandle | undefined;
    let reservation: import("./staged-delivery").StageReservations | undefined;
    let knownRemaining: number | undefined;
    let evidence: DownloadSource | undefined;
    let stat!: import("node:fs").BigIntStats;
    let owned!: { dev: string; ino: string };
    let digest!: string;
    let verification: "verified" | "unverified" | undefined;
    let resumedStage = false;
    let checkedLimits: { maxBytes: number; minimumFreeBytes: number } | undefined;
    const checkStageRoot = async () => {
      if (!delivery) return;
      await ensureSafeDirectory(delivery.root, delivery.root, false);
      const current = await fs.lstat(delivery.root, { bigint: true });
      if (String(current.dev) !== delivery.rootDev || String(current.ino) !== delivery.rootIno) throw new Error("Unsafe staging root.");
    };
    const checkStageAnchor = async () => {
      if (!delivery?.owned) throw new Error("Staging artifact ownership is unknown.");
      const { verifyArtifactAnchor } = await import("./staged-delivery.js");
      await verifyArtifactAnchor({ root: path.join(delivery.root, delivery.namespace), name: delivery.name, owned: delivery.owned });
    };
    const checkDestinationAnchor = async () => {
      const record = this.recovery[job.id];
      if (!delivery || !record?.owned) throw new Error("Destination artifact ownership is unknown.");
      const { verifyArtifactAnchor } = await import("./staged-delivery.js");
      await verifyArtifactAnchor({ root: destinationDirectory, name: record.partial, owned: record.owned });
    };
    const stageLimits = () => {
      if (!delivery) throw new Error("Staging policy is unavailable.");
      const current = this.options.stagingLimits?.();
      return { maxBytes: Math.min(delivery.maxBytes, current?.maxBytes ?? delivery.maxBytes), minimumFreeBytes: Math.max(delivery.minimumFreeBytes, current?.minimumFreeBytes ?? delivery.minimumFreeBytes) };
    };
    const countRetained = async () => {
      if (!delivery) throw new Error("Staging policy is unavailable.");
      await checkStageRoot();
      const { retainedStageBytes } = await import("./staged-delivery.js");
      return retainedStageBytes(delivery.root, Object.values(this.recovery).flatMap(record => {
        const stage = record.delivery;
        return stage && samePath(stage.root, delivery.root) && stage.stageAnchorRelease !== "released" ? [{ root: path.join(stage.root, stage.namespace), name: stage.name, owned: stage.owned, allowMissingMain: stage.phase === "stage-cleanup-pending" }] : [];
      }));
    };
    try {
      await ensureSafeDirectory(destinationRoot, destinationDirectory);
      if (delivery) {
        delete job.verification;
        if (delivery.owned && !["downloading-stage", "stage-ready", "copying"].includes(delivery.phase)) throw new Error("Staged recovery requires attention.");
        if (!delivery.owned && delivery.phase !== "downloading-stage") throw new Error("Staged recovery requires attention.");
        await checkStageRoot();
        const { stageNamespace } = await import("./staged-delivery.js");
        directory = await stageNamespace(delivery.root, delivery.namespace, this.closeTracker(job.id), this.options.stagedCloseAdapter);
        root = delivery.root;
        temp = path.join(directory, delivery.name);
        if (!delivery.owned) {
          const unowned = await fs.lstat(temp).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
          if (unowned) throw new Error("Staging artifact ownership is unknown.");
        }
        job.deliveryPhase = "downloading";
      }
      try {
        const existing = await fs.lstat(job.destination);
        job.status = "needs-attention";
        job.error =
          "Destination already exists; its contents were not verified.";
        return;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      if (delivery?.owned && delivery.phase !== "downloading-stage") {
        const { hashArtifact, StageReservations } = await import("./staged-delivery.js");
        if (!Number.isSafeInteger(delivery.length) || delivery.length! < 0 || !delivery.sha256 || !delivery.verification) throw new Error("Staged recovery requires attention.");
        const actual = await hashArtifact({ root: directory, name: delivery.name, owned: delivery.owned }, controller.signal, "stage", (_role, uncertain, settlement) => this.retainUncertain(job.id, uncertain, settlement), this.options.stagedCloseAdapter);
        if (actual.length !== delivery.length || actual.sha256 !== delivery.sha256) throw new Error("Staging content changed.");
        const record = this.recovery[job.id];
        if (record.owned) {
          await discardOwnedPartial(job, destinationRoot, record, this.closeTracker(job.id), this.options.stagedCloseAdapter);
          (delivery.retiredDestinations ??= []).push({ name: record.partial, owned: record.owned });
          delete record.owned; record.partial = `.putio-${randomUUID()}.download`;
          await this.changed(); await this.flush();
        }
        else {
          const planned = path.join(destinationDirectory, record.partial);
          const unowned = await fs.lstat(planned).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
          if (unowned) throw new Error("Destination partial ownership is unknown.");
        }
        this.stageReservations ??= Promise.resolve(new StageReservations()); reservation = await this.stageReservations;
        stat = await fs.lstat(temp, { bigint: true }); owned = delivery.owned; digest = delivery.sha256; job.bytesReceived = delivery.length!; verification = delivery.verification;
        const sourceRecord = record.source;
        if (sourceRecord) evidence = { url: "", file: { id: job.fileId, parentId: "0", name: job.name, size: job.totalBytes, isFolder: false, contentType: "" }, expectedBytes: sourceRecord.expectedBytes, zipId: sourceRecord.zipId, zipContentsVerified: delivery.zipContentsVerified };
        resumedStage = true;
      } else {
      const source = this.sources.get(job.id)!;
      const signal = controller.signal;
      signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      const canceled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Canceled"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let supplied: string | DownloadSource;
      const sourceController = new AbortController();
      const stopSource = () => sourceController.abort();
      signal.addEventListener("abort", stopSource, { once: true });
      const sourceTimeout = new AbortController();
      const budget = this.kinds.get(job.id) === "zip" ? 3780000 : 30000;
      try {
        supplied = await Promise.race([
          source(sourceController.signal), canceled,
          this.runtime.delay(budget, sourceTimeout.signal).then(() => { sourceController.abort(); throw new TemporaryDownloadError(); }),
        ]);
      } finally {
        sourceTimeout.abort(); signal.removeEventListener("abort", stopSource);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      if (controller.signal.aborted) throw new Error("Canceled");
      evidence = typeof supplied === "string" ? undefined : supplied;
      let url = typeof supplied === "string" ? supplied : supplied.url;
      if (evidence) { job.totalKnown = evidence.expectedBytes !== undefined; job.totalBytes = evidence.expectedBytes ?? 0; }
      const prior = this.recovery[job.id];
      if (prior?.source && evidence) {
        const before = prior.source;
        if ((before.kind === "zip" && typeof before.sourceIsFolder === "boolean" && before.sourceIsFolder !== evidence.file.isFolder) || before.id !== evidence.file.id || before.kind !== (evidence.zipId ? "zip" : "file") || before.updatedAt !== evidence.file.updatedAt || (before.kind === "zip" ? (before.folderSize !== undefined && evidence.file.sizeKnown !== false && before.folderSize !== evidence.file.size) : (before.expectedBytes !== evidence.expectedBytes || before.crc32 !== evidence.crc32 || before.sha1 !== evidence.sha1))) throw new Error("Source changed.");
      }
      if (delivery) {
        const helpers = await import("./staged-delivery.js");
        this.stageReservations ??= Promise.resolve(new helpers.StageReservations());
        reservation = await this.stageReservations;
        knownRemaining = evidence?.expectedBytes;
      }
      let offset = 0;
      const networkOwner = delivery ? delivery.owned : prior?.owned;
      const networkName = delivery ? delivery.name : prior?.partial;
      if (networkOwner && networkName && /^\.putio-[0-9a-f-]+\.download$/i.test(networkName)) {
        if (delivery) { const { verifyArtifactAnchor } = await import("./staged-delivery.js"); await verifyArtifactAnchor({ root: directory, name: networkName, owned: networkOwner }); }
        temp = path.join(directory, networkName);
        await ensureSafeDirectory(root, directory, false);
        const st = await fs.lstat(temp, { bigint: true }).catch((error: any) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (!st) {
          if (delivery) throw new Error("Staged recovery requires attention.");
          temp = path.join(directory, `.putio-${randomUUID()}.download`);
          delete prior.owned; job.status = "restarting"; job.bytesReceived = 0; await this.changed(); await this.flush(); job.status = "downloading";
        } else {
          if (!st.isFile() || st.isSymbolicLink() || String(st.dev) !== networkOwner.dev || String(st.ino) !== networkOwner.ino) throw new Error("Unsafe partial.");
          offset = Number(st.size);
          handle = await fs.open(temp, "r+");
          const opened = await handle.stat({ bigint: true });
          if (String(opened.dev) !== networkOwner.dev || String(opened.ino) !== networkOwner.ino) throw new Error("Unsafe partial.");
          if ((evidence?.zipId && prior.source?.zipId !== evidence.zipId) || !prior.source?.etag || prior.source.encoding !== "identity" || (evidence?.expectedBytes !== undefined && offset >= evidence.expectedBytes)) {
            job.status = "restarting"; job.bytesReceived = 0; await this.changed(); await this.flush();
            controller.signal.throwIfAborted(); if (this.paused || this.stopping || this.recovery[job.id]?.intent !== "run") { controller.abort(); throw new Error("Canceled"); } await handle.truncate(0); controller.signal.throwIfAborted(); if (this.paused || this.stopping || this.recovery[job.id]?.intent !== "run") { controller.abort(); throw new Error("Canceled"); } offset = 0; job.status = "downloading";
          }
        }
      }
      if (delivery && reservation && knownRemaining !== undefined) {
        knownRemaining = Math.max(0, knownRemaining - offset); const limits = stageLimits();
        await reservation.reserve(job.id, delivery.root, knownRemaining, countRetained, limits.maxBytes, limits.minimumFreeBytes); checkedLimits = limits;
      }
      const rejectChangedValidator = (response: Response) => {
        const accepted = evidence?.zipId && prior?.source?.zipId !== evidence.zipId ? undefined : prior?.source?.etag;
        const current = response.headers.get("etag") ?? "";
        if (accepted && /^"[^"\r\n]{1,200}"$/.test(accepted) && /^"[^"\r\n]{1,200}"$/.test(current) && current !== accepted) throw new Error("Source changed.");
      };
      const rejectTemporary = async (response: Response) => {
        if (response.status !== 408 && response.status !== 429 && response.status < 500) return;
        const raw = response.headers.get("retry-after") ?? "";
        const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : 0;
        const date = /^[A-Za-z]{3}, .* GMT$/.test(raw) ? Date.parse(raw) : NaN;
        const minimum = Number.isFinite(date) ? Math.max(0, date - this.runtime.now()) : Number.isFinite(seconds) ? seconds * 1000 : 0;
        const safeMinimum = Number.isFinite(new Date(this.runtime.now() + minimum).getTime()) ? minimum : 0;
        await response.body?.cancel();
        throw new TemporaryDownloadError(safeMinimum);
      };
      controller.signal.throwIfAborted();
      let response = await this.fetchHeaders(url, offset ? { Range: `bytes=${offset}-`, "If-Range": prior!.source!.etag! } : { "Accept-Encoding": "identity" }, controller.signal);
      controller.signal.throwIfAborted();
      await rejectTemporary(response);
      if ([401, 403, 404].includes(response.status)) {
        await response.body?.cancel();
        const renewed = await source(signal); controller.signal.throwIfAborted();
        if (typeof renewed !== "string" && evidence && ((evidence.zipId && renewed.file.isFolder !== evidence.file.isFolder) || renewed.file.id !== evidence.file.id || Boolean(renewed.zipId) !== Boolean(evidence.zipId) || renewed.file.updatedAt !== evidence.file.updatedAt || (evidence.zipId ? (evidence.file.sizeKnown !== false && renewed.file.sizeKnown !== false && renewed.file.size !== evidence.file.size) : (renewed.expectedBytes !== evidence.expectedBytes || renewed.crc32 !== evidence.crc32 || renewed.sha1 !== evidence.sha1)))) throw new Error("Source changed.");
        if (typeof renewed !== "string") {
          if (renewed.zipId && renewed.zipId !== evidence?.zipId && offset) {
            await ensureSafeDirectory(root, directory, false);
            if (delivery) await checkStageAnchor();
            const current = await fs.lstat(temp, { bigint: true });
            if (!current.isFile() || current.isSymbolicLink() || String(current.dev) !== networkOwner!.dev || String(current.ino) !== networkOwner!.ino) throw new Error("Unsafe partial.");
            job.status = "restarting"; job.bytesReceived = 0; await this.changed(); await this.flush();
            controller.signal.throwIfAborted(); if (this.paused || this.stopping || this.recovery[job.id]?.intent !== "run") { controller.abort(); throw new Error("Canceled"); } await handle!.truncate(0); controller.signal.throwIfAborted(); if (this.paused || this.stopping || this.recovery[job.id]?.intent !== "run") { controller.abort(); throw new Error("Canceled"); } offset = 0; job.status = "downloading";
            if (delivery && reservation && renewed.expectedBytes !== undefined) { knownRemaining = renewed.expectedBytes; const limits = stageLimits(); await reservation.reserve(job.id, delivery.root, knownRemaining, countRetained, limits.maxBytes, limits.minimumFreeBytes); checkedLimits = limits; }
          }
          evidence = renewed; job.totalKnown = evidence.expectedBytes !== undefined; job.totalBytes = evidence.expectedBytes ?? 0;
        }
        url = typeof renewed === "string" ? renewed : renewed.url;
        response = await this.fetchHeaders(url, offset ? { Range: `bytes=${offset}-`, "If-Range": prior!.source!.etag! } : { "Accept-Encoding": "identity" }, controller.signal);
        controller.signal.throwIfAborted();
        await rejectTemporary(response);
        if ([401, 403, 404].includes(response.status)) { await response.body?.cancel(); throw new TemporaryDownloadError(); }
      }
      if (response.status === 200 || response.status === 206) rejectChangedValidator(response);
      if (offset) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        const sameTag = response.headers.get("etag") === prior!.source!.etag;
        const validRange = response.status === 206 && range && Number(range[1]) === offset && Number(range[2]) === Number(range[3]) - 1 && Number(range[3]) === evidence?.expectedBytes && sameTag && (response.headers.get("content-encoding") ?? "identity") === "identity";
        if (!validRange) {
          await ensureSafeDirectory(root, directory, false);
          if (delivery) await checkStageAnchor();
          const current = await fs.lstat(temp, { bigint: true });
          if (!current.isFile() || current.isSymbolicLink() || String(current.dev) !== networkOwner!.dev || String(current.ino) !== networkOwner!.ino) throw new Error("Unsafe partial.");
          job.status = "restarting"; job.bytesReceived = 0; await this.changed(); await this.flush();
          await handle!.truncate(0); offset = 0; job.status = "downloading";
          if (delivery && reservation && evidence?.expectedBytes !== undefined) { knownRemaining = evidence.expectedBytes; const limits = stageLimits(); await reservation.reserve(job.id, delivery.root, knownRemaining, countRetained, limits.maxBytes, limits.minimumFreeBytes); checkedLimits = limits; }
          if (response.status !== 200 || (response.headers.get("content-encoding") ?? "identity") !== "identity") {
            await response.body?.cancel(); response = await this.fetchHeaders(url, { "Accept-Encoding": "identity" }, controller.signal); await rejectTemporary(response); if (response.status === 200 || response.status === 206) rejectChangedValidator(response);
          }
        }
      }
      if (response.status !== (offset ? 206 : 200) || !response.body) throw new InvalidDownloadResponse("Download failed.");
      const started = Date.now();
      const sha1 = createHash("sha1");
      const sha256 = createHash("sha256");
      let crc = 0;
      if (offset) {
        const buffer = Buffer.alloc(64 * 1024);
        for (let position = 0; position < offset;) {
          const { bytesRead } = await handle!.read(buffer, 0, Math.min(buffer.length, offset - position), position);
          if (!bytesRead) throw new Error("Unsafe partial.");
          const chunk = buffer.subarray(0, bytesRead); sha1.update(chunk); sha256.update(chunk); crc = crc32(chunk, crc); position += bytesRead;
        }
      }
      job.bytesReceived = offset;
      let jobNext = 0;
      let lastSpaceCheck = Date.now(), lastSpaceBytes = offset;
      await ensureSafeDirectory(root, directory, false);
      if (!handle) {
        handle = delivery ? await fs.open(temp, "wx", 0o600) : await fs.open(temp, "wx");
        const owned = await handle.stat({ bigint: true });
        const identity = delivery ? await (await import("./staged-delivery.js")).createArtifactAnchor(directory, path.basename(temp), handle, undefined, this.closeTracker(job.id), this.options.stagedCloseAdapter) : { dev: String(owned.dev), ino: String(owned.ino) };
        this.recovery[job.id] = { ...prior, version: 1, intent: this.recovery[job.id]?.intent ?? "run", kind: evidence?.zipId ? "zip" : "file", partial: path.basename(temp), owned: identity, source: { id: evidence?.file.id ?? job.fileId, kind: evidence?.zipId ? "zip" : "file", expectedBytes: evidence?.expectedBytes, crc32: evidence?.crc32, sha1: evidence?.sha1, updatedAt: evidence?.file.updatedAt, folderSize: evidence?.zipId && evidence.file.sizeKnown !== false ? evidence.file.size : undefined, sourceIsFolder: evidence?.zipId ? evidence.file.isFolder : undefined, ...(((prior?.source?.zipId === evidence?.zipId && prior?.source?.etag) || /^"[^"\r\n]{1,200}"$/.test(response.headers.get("etag") ?? "")) ? { etag: (prior?.source?.zipId === evidence?.zipId ? prior?.source?.etag : undefined) ?? response.headers.get("etag")! } : {}), encoding: prior?.source?.zipId === evidence?.zipId && prior?.source?.etag && !/^"[^"\r\n]{1,200}"$/.test(response.headers.get("etag") ?? "") ? "unknown" : response.headers.get("content-encoding") ?? "identity", zipId: evidence?.zipId } };
        if (delivery) {
          const current = this.recovery[job.id];
          delivery.owned = current.owned;
          current.partial = prior.partial;
          delete current.owned;
        }
        await this.changed(); await this.flush();
        controller.signal.throwIfAborted();
      }
      if (!offset && prior?.source && this.recovery[job.id] === prior) {
        const responseTag = response.headers.get("etag") ?? "";
        if (evidence?.zipId && prior.source.zipId !== evidence.zipId) {
          prior.source = { id: evidence.file.id, kind: "zip", expectedBytes: evidence.expectedBytes, crc32: evidence.crc32, sha1: evidence.sha1, updatedAt: evidence.file.updatedAt, folderSize: evidence.file.sizeKnown !== false ? evidence.file.size : undefined, sourceIsFolder: evidence.file.isFolder, zipId: evidence.zipId };
        }
        if (/^"[^"\r\n]{1,200}"$/.test(responseTag)) prior.source.etag = responseTag;
        prior.source.encoding = prior.source.etag && !/^"[^"\r\n]{1,200}"$/.test(responseTag) ? "unknown" : response.headers.get("content-encoding") ?? "identity";
        await this.changed(); await this.flush();
      }
      const reader = response.body.getReader();
      const stagingBuffer = delivery ? Buffer.alloc(64 * 1024) : undefined;
      const abortReader = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", abortReader, { once: true });
      try {
        let position = offset;
        while (true) {
          controller.signal.throwIfAborted();
          const timeout = new AbortController();
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await Promise.race([
              reader.read().catch(() => { throw new TemporaryDownloadError(); }),
              this.runtime.delay(30000, timeout.signal).then(() => { throw new TemporaryDownloadError(); }),
            ]);
          } finally { timeout.abort(); }
          controller.signal.throwIfAborted();
          if (result.done) break;
          const chunk = delivery ? result.value : Buffer.from(result.value);
          for (let index = 0; index < chunk.length;) {
            controller.signal.throwIfAborted();
            const now = this.runtime.now();
            const rate = this.globalRate();
            if (rate !== this.aggregateRate) { this.aggregateRate = rate; this.aggregateNext = now; }
            const jobRate = job.speedLimitBytesPerSecond ?? 0;
            const size = !rate && !jobRate ? Math.min(delivery ? 65536 : chunk.length - index, chunk.length - index) : Math.max(1, Math.min(16384, rate > 0 ? Math.max(1, Math.floor(rate / 10)) : 16384, jobRate > 0 ? Math.max(1, Math.floor(jobRate / 10)) : 16384, chunk.length - index));
            if (rate > 0) this.aggregateNext = Math.max(now, this.aggregateNext) + size * 1000 / rate;
            if (jobRate > 0) jobNext = Math.max(now, jobNext) + size * 1000 / jobRate;
            const wait = Math.max(0, this.aggregateNext - now, jobNext - now);
            if (wait) await this.runtime.delay(wait, controller.signal);
            controller.signal.throwIfAborted();
            const view = chunk.subarray(index, index + size);
            if (stagingBuffer) stagingBuffer.set(view, 0);
            const part = stagingBuffer ? stagingBuffer.subarray(0, size) : view;
            if (delivery) await checkStageRoot();
            if (delivery && reservation) {
              if (knownRemaining !== undefined && part.length > knownRemaining) throw new Error("Downloaded bytes exceeded the reserved source length.");
              const limits = stageLimits();
              if (knownRemaining !== undefined && (position - lastSpaceBytes >= 8 * 1024 ** 2 || Date.now() - lastSpaceCheck >= 1000 || limits.maxBytes !== checkedLimits?.maxBytes || limits.minimumFreeBytes !== checkedLimits?.minimumFreeBytes)) {
                await reservation.reserve(job.id, delivery.root, knownRemaining, countRetained, limits.maxBytes, limits.minimumFreeBytes);
                checkedLimits = limits; lastSpaceCheck = Date.now(); lastSpaceBytes = position;
              }
              if (knownRemaining === undefined) {
                await reservation.reserve(job.id, delivery.root, part.length, countRetained, limits.maxBytes, limits.minimumFreeBytes);
              }
            }
            for (let written = 0; written < part.length;) {
              const result = await handle.write(part, written, part.length - written, position + written);
              if (!result.bytesWritten) throw new Error("Could not write download.");
              written += result.bytesWritten;
              if (delivery && reservation) { job.bytesReceived += result.bytesWritten; await reservation.consume(job.id, result.bytesWritten); if (knownRemaining !== undefined) knownRemaining -= result.bytesWritten; }
              controller.signal.throwIfAborted();
            }
            sha1.update(part); sha256.update(part); crc = crc32(part, crc);
            index += size; position += size; if (!delivery) job.bytesReceived += size;
            job.speed = job.bytesReceived / Math.max(1, (Date.now() - started) / 1000);
            this.changed();
          }
        }
      } finally {
        controller.signal.removeEventListener("abort", abortReader);
        await reader.cancel().catch(() => {});
      }
      controller.signal.throwIfAborted();
      if (delivery) await handle.sync();
      if (delivery) {
        const closing = handle; handle = undefined;
        const { closeArtifact } = await import("./staged-delivery.js");
        await closeArtifact(closing, "stage", (_role, uncertain, settlement) => this.retainUncertain(job.id, uncertain, settlement), this.options.stagedCloseAdapter);
      } else await handle.close();
      handle = undefined;
      await ensureSafeDirectory(root, directory, false);
      stat = await fs.lstat(temp, { bigint: true });
      controller.signal.throwIfAborted();
      owned = delivery?.owned ?? this.recovery[job.id].owned!;
      if (delivery) { const { verifyArtifactAnchor } = await import("./staged-delivery.js"); await verifyArtifactAnchor({ root: directory, name: delivery.name, owned: delivery.owned }); }
      if (String(stat.dev) !== owned.dev || String(stat.ino) !== owned.ino) throw new Error("Unsafe partial.");
      const checksum = sha1.digest("hex");
      const mismatch = !stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== job.bytesReceived ||
        (evidence?.expectedBytes !== undefined && Number(stat.size) !== evidence.expectedBytes) ||
        (evidence?.crc32 !== undefined && (!/^[0-9a-f]{8}$/i.test(evidence.crc32) || crc.toString(16).padStart(8, "0") !== evidence.crc32.toLowerCase())) ||
        (evidence?.sha1 !== undefined && (!/^[0-9a-f]{40}$/i.test(evidence.sha1) || checksum !== evidence.sha1.toLowerCase()));
      if (mismatch) {
        // Retain the partial: the pathname may no longer identify the file we created.
        job.status = "needs-attention";
        job.error = "Downloaded bytes did not match source evidence.";
        return;
      }
      verification = !evidence || evidence.expectedBytes !== undefined ? "verified" : "unverified";
      if (!delivery) job.verification = verification;
      digest = sha256.digest("hex");
      }
      if (delivery) {
        const { copyArtifact } = await import("./staged-delivery.js");
        delivery.phase = "stage-ready"; delivery.length = Number(stat.size); delivery.sha256 = digest; delivery.verification = verification; delivery.zipContentsVerified = evidence?.zipContentsVerified;
        await this.changed(); await this.flush(); controller.signal.throwIfAborted();
        await ensureSafeDirectory(destinationRoot, destinationDirectory, false);
        await reservation!.reserveDestination(job.id, destinationDirectory, Number(stat.size), stageLimits().minimumFreeBytes);
        delivery.phase = "copying"; job.status = "copying"; job.deliveryPhase = "copying"; job.deliveryBytesCopied = 0; job.speed = 0;
        await this.changed(); await this.flush(); controller.signal.throwIfAborted();
        const target = { root: destinationDirectory, name: this.recovery[job.id].partial, anchorNamespace: delivery.namespace };
        let accountedCopyBytes = 0, lastCopyCheck = Date.now(), lastCopyBytes = 0, copyReserve = stageLimits().minimumFreeBytes;
        const copied = await copyArtifact({ root: directory, name: delivery.name, owned: delivery.owned }, target, { length: Number(stat.size), sha256: digest }, controller.signal, async identity => { this.recovery[job.id].owned = identity; await this.changed(); await this.flush(); }, async bytes => {
          await reservation!.consume(job.id, bytes - accountedCopyBytes); accountedCopyBytes = bytes;
          const minimum = stageLimits().minimumFreeBytes;
          if (bytes - lastCopyBytes >= 8 * 1024 ** 2 || Date.now() - lastCopyCheck >= 1000 || minimum !== copyReserve) {
            await reservation!.reserveDestination(job.id, destinationDirectory, Number(stat.size) - bytes, minimum);
            lastCopyCheck = Date.now(); lastCopyBytes = bytes; copyReserve = minimum;
          }
          job.deliveryBytesCopied = bytes; this.changed();
        }, (_role, uncertain, settlement) => this.retainUncertain(job.id, uncertain, settlement), this.options.stagedCloseAdapter);
        await checkStageRoot();
        const { stageNamespace } = await import("./staged-delivery.js"); await stageNamespace(delivery.root, delivery.namespace, this.closeTracker(job.id), this.options.stagedCloseAdapter);
        owned = copied; root = destinationRoot; directory = destinationDirectory; temp = path.join(directory, target.name); job.deliveryPhase = "verifying-destination";
      }
      job.status = "finalizing";
      if (delivery) await checkDestinationAnchor();
      const identity = await fs.lstat(temp, { bigint: true });
      if (!identity.isFile() || identity.isSymbolicLink() || String(identity.dev) !== owned.dev || String(identity.ino) !== owned.ino || Number(identity.size) !== Number(stat.size)) throw new Error("Unsafe partial.");
      this.recovery[job.id].finalization = { phase: "prepared", length: Number(stat.size), sha256: digest, dev: String(identity.dev), ino: String(identity.ino), verification: verification! };
      if (delivery) delivery.phase = "destination-prepared";
      await this.changed();
      await this.flush();
      await ensureSafeDirectory(root, directory, false);
      if (delivery) await checkDestinationAnchor();
      if (this.stopping || this.paused || this.recovery[job.id]?.intent !== "run") {
        const record = this.recovery[job.id];
        delete record.finalization;
        if (record.delivery) record.delivery.phase = "copying";
        if (record.intent === "canceled") {
          await discardOwnedPartial(job, root, record, this.closeTracker(job.id), this.options.stagedCloseAdapter); if (record.delivery) await discardOwnedStage(record, this.closeTracker(job.id), this.options.stagedCloseAdapter); job.bytesReceived = 0; job.status = "canceled";
        } else job.status = this.stopping ? "interrupted" : "paused";
        job.speed = 0; await this.changed(); await this.flush();
        if (record.delivery && record.intent === "canceled") await releaseStagedAnchors(job, record, async () => { await this.changed(); await this.flush(); }, this.closeTracker(job.id), this.options.stagedCloseAdapter);
        return;
      }
      this.publishing.add(job.id);
      try { await fs.link(temp, job.destination); } finally { this.publishing.delete(job.id); }
      const linked = await fs.lstat(job.destination, { bigint: true });
      if (delivery) await checkDestinationAnchor();
      if (!linked.isFile() || linked.isSymbolicLink() || String(linked.dev) !== owned.dev || String(linked.ino) !== owned.ino) throw new Error("Unsafe partial.");
      if (delivery) {
        const output = await fs.open(job.destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let position = 0;
          while (true) { controller.signal.throwIfAborted(); const read = await output.read(buffer, 0, buffer.length, position); if (!read.bytesRead) break; hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead; }
          const opened = await output.stat({ bigint: true }); const current = await fs.lstat(job.destination, { bigint: true });
          await ensureSafeDirectory(destinationRoot, destinationDirectory, false);
          await checkDestinationAnchor();
          if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || String(opened.dev) !== owned.dev || String(opened.ino) !== owned.ino || String(current.dev) !== owned.dev || String(current.ino) !== owned.ino || position !== delivery.length || Number(opened.size) !== position || Number(current.size) !== position || hash.digest("hex") !== digest) throw new Error("Published destination could not be verified.");
        } finally {
          const { closeArtifact } = await import("./staged-delivery.js");
          await closeArtifact(output, "destination", (_role, uncertain, settlement) => this.retainUncertain(job.id, uncertain, settlement), this.options.stagedCloseAdapter);
        }
      }
      if (delivery) job.verification = verification;
      this.recovery[job.id].finalization!.phase = "published";
      if (delivery) delivery.phase = "published";
      if (this.cleanup.has(job.id)) this.recovery[job.id].cleanup = { phase: "not-started", step: "file" };
      await this.flush();
      await ensureSafeDirectory(root, directory, false);
      if (delivery) await checkDestinationAnchor();
      const beforeRemoval = await fs.lstat(temp, { bigint: true });
      if (!beforeRemoval.isFile() || beforeRemoval.isSymbolicLink() || String(beforeRemoval.dev) !== owned.dev || String(beforeRemoval.ino) !== owned.ino) throw new Error("Unsafe partial.");
      await fs.unlink(temp);
      if (delivery) await (await import("./staged-delivery.js")).syncAnchorDirectory(directory, this.closeTracker(job.id), this.options.stagedCloseAdapter);
      if (delivery) {
        delivery.phase = "stage-cleanup-pending"; await this.flush();
        try {
          await discardOwnedStage(this.recovery[job.id], this.closeTracker(job.id), this.options.stagedCloseAdapter);
          job.stagingWarning = undefined; await this.flush();
          await releaseStageAnchor(this.recovery[job.id], async () => { await this.changed(); await this.flush(); }, this.closeTracker(job.id), this.options.stagedCloseAdapter);
        }
        catch (error) { if (await this.retainCloseError(job.id, error)) throw error; job.stagingWarning = "The verified output is safe, but its staged copy could not be removed."; await this.flush().catch(() => {}); }
        job.deliveryPhase = undefined;
      }
      job.completedAt = new Date().toISOString();
      job.cleanupStatus = this.cleanup.has(job.id) ? "not-started" : "not-required";
      if (this.cleanup.has(job.id) && (job.verification === "unverified" || (evidence?.zipId && !evidence.zipContentsVerified))) job.cleanupWarning = "Source retained because cleanup eligibility could not be verified.";
      let cleanupSourceValid = !resumedStage;
      if (resumedStage && this.cleanup.has(job.id) && !this.paused && this.recovery[job.id]?.intent === "run") {
        try {
          const original = this.recovery[job.id].source; const lookup = this.sourceIdentities.get(job.id);
          if (!original || !lookup) throw new Error("Source identity unavailable.");
          const current = await lookup(controller.signal); const expectedSize = original.kind === "zip" ? original.folderSize : original.expectedBytes;
          if (current.id !== original.id || current.updatedAt !== original.updatedAt || (original.kind === "zip" && typeof original.sourceIsFolder === "boolean" && current.isFolder !== original.sourceIsFolder) || (expectedSize !== undefined && (current.sizeKnown === false || current.size !== expectedSize)) || (original.kind === "file" && (current.crc32 !== original.crc32 || current.sha1 !== original.sha1))) throw new Error("Source identity changed.");
          cleanupSourceValid = true;
        } catch { job.cleanupWarning = "Source retained because its identity could not be revalidated."; }
      }
      if (this.cleanup.has(job.id) && cleanupSourceValid && !this.paused && this.recovery[job.id]?.intent === "run" && job.verification === "verified" && (!evidence?.zipId || evidence.zipContentsVerified)) {
        if (delivery) await checkDestinationAnchor();
        job.status = "cleaning";
        const marker = this.recovery[job.id].cleanup!;
        let dispatched = false;
        try {
          await this.changed();
          marker.phase = "in-flight";
          await this.flush();
          if (!this.paused && this.recovery[job.id]?.intent === "run") {
            if (delivery) await checkDestinationAnchor();
            dispatched = true;
            const pendingFolders = await this.cleanup.get(job.id)!();
            marker.phase = pendingFolders ? "not-started" : "succeeded";
            marker.step = pendingFolders ? "folder" : "file";
            await this.flush();
            job.cleanupStatus = pendingFolders ? "not-started" : "succeeded";
          } else {
            marker.phase = "not-started";
            await this.flush();
            job.cleanupWarning = "Source cleanup was not started.";
          }
        } catch (error) {
          const definite = dispatched && error instanceof PutioRequestError && [400, 401, 403].includes(error.status ?? 0);
          marker.phase = dispatched ? (definite ? "failed" : "unknown") : "not-started";
          job.cleanupStatus = marker.phase;
          job.cleanupWarning = dispatched ? (definite ? "Source cleanup failed." : "Source cleanup outcome is unknown.") : "Source cleanup was not started.";
          await this.flush().catch(() => {});
        }
      }
      job.status = job.verification === "unverified" ? "unverified" : "completed";
      const terminalRecord = this.recovery[job.id];
      if (delivery && !job.stagingWarning && !this.uncertainCloses.has(job.id) && (!terminalRecord.cleanup || terminalRecord.cleanup.phase === "succeeded" || (terminalRecord.cleanup.step === "file" && terminalRecord.cleanup.phase !== "in-flight"))) {
        await this.changed(); await this.flush();
        await releaseStagedAnchors(job, terminalRecord, async () => { await this.changed(); await this.flush(); }, this.closeTracker(job.id), this.options.stagedCloseAdapter);
      }
    } catch (error: any) {
      let closeFailed = this.uncertainCloses.has(job.id);
      if (delivery) {
        const { ArtifactCloseUncertain } = await import("./staged-delivery.js");
        if (error instanceof ArtifactCloseUncertain) { closeFailed = true; this.retainUncertain(job.id, error.handle, error.settlement); }
      }
      if (handle) {
        try {
          if (delivery) { const { closeArtifact } = await import("./staged-delivery.js"); await closeArtifact(handle, "stage", (_role, uncertain, settlement) => this.retainUncertain(job.id, uncertain, settlement), this.options.stagedCloseAdapter); }
          else await handle.close();
        } catch { closeFailed = true; this.uncertainCloses.add(job.id); if (this.recovery[job.id]) this.recovery[job.id].closeUncertainProcess = downloadProcessInstance; }
      }
      if (!closeFailed && !controller.signal.aborted && (error instanceof TemporaryDownloadError || (error instanceof PutioRequestError && error.kind === "transient"))) {
        job.status = "waiting"; job.attemptCount = (job.attemptCount ?? 0) + 1;
        const count = job.attemptCount;
        const base = count <= 5 ? 1000 * 2 ** (count - 1) : 300000;
        const jitter = count <= 5 ? base * 0.2 : 30000;
        const now = this.runtime.now();
        const suppliedWait = error.retryAfterMs ?? 0;
        const serverWait = Number.isFinite(new Date(now + suppliedWait).getTime()) ? suppliedWait : 0;
        job.retryAt = new Date(now + Math.max(serverWait, base + Math.floor(jitter * this.runtime.random()))).toISOString();
        const record = this.recovery[job.id]; if (record) { record.retryCount = count; record.retryAt = job.retryAt; }
        job.error = undefined; job.speed = 0;
        try { await this.changed(); await this.flush(); }
        catch {
          if (job.status === "waiting" && record?.intent === "run") {
            job.status = "needs-attention"; job.error = "Could not save job state; retry was not scheduled.";
            delete job.retryAt; delete record.retryAt;
          }
        }
        return;
      }
      job.status = controller.signal.aborted ? (this.stopping ? "interrupted" : this.recovery[job.id]?.intent === "canceled" ? "canceled" : this.paused ? "paused" : "canceled") : (closeFailed || (error instanceof PutioRequestError && error.kind !== "transient") || error instanceof InvalidDownloadResponse || error.code === "EIO" || error.code === "ENOSPC" || error.code === "EACCES" || error.code === "EEXIST" || (delivery && ["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"].includes(error.code)) || this.recovery[job.id]?.finalization || error.message === "Unsafe partial." || error.message?.includes("Staged recovery") || error.message?.includes("Staging content") || error.message?.includes("Staging namespace") || error.message === "Destination copy did not verify." || error.message?.includes("ownership is unknown") || error.message?.includes("capacity") || error.message?.includes("storage") || error.message?.includes("reserved source length") || error.message === "Source changed." || (error.message?.startsWith("Unsafe download") || error.message?.startsWith("Unsafe staging"))) ? "needs-attention" : "failed";
      if (delivery && closeFailed) job.status = "needs-attention";
      if (job.status === "paused" || job.status === "interrupted") {
        const record = this.recovery[job.id];
        if (delivery?.owned) {
          try { await checkStageAnchor(); }
          catch { job.status = "needs-attention"; job.error = "Staged artifact ownership requires inspection."; job.speed = 0; return; }
          const stageDirectory = path.join(delivery.root, delivery.namespace);
          await ensureSafeDirectory(delivery.root, stageDirectory, false);
          const st = await fs.lstat(path.join(stageDirectory, delivery.name), { bigint: true });
          if (st.isFile() && !st.isSymbolicLink() && String(st.dev) === delivery.owned.dev && String(st.ino) === delivery.owned.ino) job.bytesReceived = Number(st.size);
        } else if (record?.owned) {
          await ensureSafeDirectory(root, directory, false);
          const st = await fs.lstat(path.join(directory, record.partial), { bigint: true });
          if (st.isFile() && !st.isSymbolicLink() && String(st.dev) === record.owned.dev && String(st.ino) === record.owned.ino) job.bytesReceived = Number(st.size);
        }
        job.speed = 0;
      }
      job.error = delivery && closeFailed ? "Download file could not be safely closed."
        : controller.signal.aborted ? undefined
        : closeFailed ? "Download file could not be safely closed."
        : error.message?.includes("Staging namespace") ? "Staging directory is not private to the engine user."
        : error.message === "Published destination could not be verified." ? "Published destination could not be verified; source was retained."
        : error.message === "Destination copy did not verify." || error.message?.includes("Staging content") ? "Staged or destination bytes could not be verified; source was retained."
        : delivery?.phase === "destination-prepared" && ["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"].includes(error.code) ? "Destination cannot publish safely; the staged copy was retained."
        : delivery && ["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"].includes(error.code) ? "Staging or destination cannot create a safe ownership anchor; inspect filesystem support."
        : error.message?.includes("ownership is unknown") ? "A staged or destination artifact has unknown ownership; inspect it before retrying."
        : delivery && error.code === "ENOSPC" ? "Staging or destination is full; any owned bytes were retained. Free space and retry."
        : delivery && ["EIO", "EACCES"].includes(error.code) ? "Staging or destination I/O failed; any owned bytes were retained. Inspect access and retry."
        : error.message === "Could not determine available storage." ? "Could not check free space on staging or destination; inspect the filesystem and retry."
        : error.message?.includes("capacity") || error.message?.includes("storage") ? "Insufficient staging or destination space; free space and retry."
        : error.message === "Source changed."
          ? "Source changed; retry to accept the refreshed source."
          : error.code === "EEXIST"
          ? (delivery?.phase === "downloading-stage" ? "Staging artifact already exists with unknown ownership." : delivery?.phase === "copying" ? "Destination partial already exists with unknown ownership." : "Destination already exists.")
          : "Download failed.";
    } finally {
      if (reservation) await reservation.release(job.id);
    }
  }
}
