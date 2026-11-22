import { constants, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PutioApi, PutioRequestError } from "../core/api";
import { connectDevice } from "../core/device-auth";
import { DownloadQueue, DownloadRecovery, DownloadRuntime, downloadProcessInstance, recoverPublished, discardOwnedPartial, discardOwnedStage, releaseStageAnchor, releaseStagedAnchors, ensureSafeDirectory, pathIdentity, samePath } from "../core/downloads";
import { RuleScanner, safeName } from "../core/rules";
import { CredentialAdapter, SettingsStore, validSchedule } from "../core/settings";
import { AutoDownloadRule, DownloadJob, RemoteFile, Settings } from "../shared";
import { EngineClient, EngineCommand, EngineSnapshot } from "./contracts";
import { acquireStateLock } from "./state-lock";
import { storageStatus } from "./storage";

export interface QuiescentEngineOwner { close(): Promise<void> }
export class EngineStartupFailure extends Error {
  constructor(readonly owner: QuiescentEngineOwner, cause: unknown) {
    super("Engine startup failed while a file close remains uncertain; state ownership is held.", { cause });
  }
}
export interface EngineOptions {
  stateDirectory: string;
  credentials: CredentialAdapter;
  label?: string;
  apiBase?: string;
  transport?: typeof fetch;
  roots?: { id: string; label: string; path: string }[];
  stagingDirectory?: string;
  token?: string;
  now?: () => Date;
  downloadRuntime?: DownloadRuntime;
  stagedCloseAdapter?: import("../core/staged-delivery").CloseAdapter;
}
type FolderCleanup = { ancestry: string[]; ruleId?: string; ruleRoot?: string; extensions: string[]; minSizeBytes: number };
type StagingPolicy = { root: string; rootDev: string; rootIno: string; namespace: string; maxBytes: number; minimumFreeBytes: number };
type Description = { staging?: StagingPolicy; file: RemoteFile; dir: string; root: string; zip: boolean; cleanup: boolean; deleteSourceFolders?: boolean; folderCleanupKeep?: boolean; folderCleanup?: FolderCleanup; speedLimitBytesPerSecond?: number };
type FolderCandidate = { jobId: string; folderId: string; description: Description };
type Receipt = { fingerprint: string; jobId: string };
type StagingProbe = { root: string; rootDev: string; rootIno: string; name: string; owned?: { dev: string; ino: string } };
type State = { version: 1; stagingProbe?: StagingProbe; id: string; paused: boolean; stagingNotice?: string; jobs: DownloadJob[]; descriptions: Record<string, Description>; receipts: Record<string, Receipt>; recovery?: Record<string, DownloadRecovery> };
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new Error("Invalid remote ID.");
  return value;
};
const name = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\x00-\x1f]/.test(value)) throw new Error("Invalid name.");
  return value;
};
export class ApplicationEngine implements EngineClient {
  private store: SettingsStore;
  private api: PutioApi;
  private queue: DownloadQueue;
  private scanner: RuleScanner;
  private allowed = new Map<string, string>();
  private stagingRoot?: string;
  private roots: { id: string; label: string; path: string; aliasPath?: string }[];
  private state: State = { version: 1, id: randomUUID(), paused: false, jobs: [], descriptions: {}, receipts: {} };
  private epoch = randomUUID();
  private revision = 0;
  private connection: EngineSnapshot["connection"] = { status: "disconnected" };
  private scanStatus = "idle";
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private timer?: NodeJS.Timeout;
  private nextRuns: Record<string, number> = {};
  private progressTimer?: NodeJS.Timeout;
  private writes: Promise<void> = Promise.resolve();
  private commands: Promise<unknown> = Promise.resolve();
  private enqueueWrites: Promise<unknown> = Promise.resolve();
  private accepting = false;
  private folderCandidates = new Map<string, FolderCandidate>();
  private folderDrain?: Promise<void>;
  private folderDrainRequested = false;
  private rulesGeneration = 0;
  private jobStates = "";
  private closed = false;
  private shutdownSignal = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private releaseLock?: () => Promise<void>;
  private closing?: Promise<void>;
  private linkGeneration = 0;
  private linkAbort?: AbortController;
  private connectionBeforeLink: EngineSnapshot["connection"] = { status: "disconnected" };
  private constructor(private options: EngineOptions) {
    this.store = new SettingsStore(options.stateDirectory, options.credentials);
    this.api = new PutioApi(() => this.store.token, options.apiBase, options.transport, options.downloadRuntime);
    this.roots = options.roots ?? [];
    this.queue = new DownloadQueue(() => this.store.settings.parallelDownloads, () => { const changed = this.queueChanged(); void changed?.catch(() => {}); return changed; }, options.transport, () => this.persist(), () => this.store.settings.speedLimitBytesPerSecond, { runtime: options.downloadRuntime, stagingLimits: () => ({ maxBytes: this.store.settings.stagingMaxBytes, minimumFreeBytes: this.store.settings.stagingMinimumFreeBytes }), stagedCloseAdapter: options.stagedCloseAdapter });
    this.scanner = new RuleScanner(async (folder) => { const files = await this.api.listFiles(folder, this.shutdownSignal.signal); this.ensureOpen(); return files; }, async (file, dir, root, rule, ancestry) => {
      if (this.closed || this.state.paused) return;
      await this.enqueue({ file, dir, root, zip: false, cleanup: rule.deleteAfterDownload ?? this.store.settings.deleteAfterDownload, deleteSourceFolders: rule.deleteSourceFolders ?? this.store.settings.deleteSourceFolders, folderCleanupKeep: rule.deleteSourceFolders === false, folderCleanup: { ancestry, ruleId: rule.id, ruleRoot: rule.folderId, extensions: [...rule.extensions], minSizeBytes: rule.minSizeBytes }, speedLimitBytesPerSecond: rule.speedLimitBytesPerSecond ?? this.store.settings.speedLimitBytesPerSecond });
    });
  }
  static async create(options: EngineOptions): Promise<ApplicationEngine> {
    if (!path.isAbsolute(options.stateDirectory)) throw new Error("State directory must be absolute.");
    await fs.mkdir(options.stateDirectory, { recursive: true });
    options = { ...options, stateDirectory: await fs.realpath(options.stateDirectory), roots: options.roots?.map(root => ({ ...root })) };
    const engine = new ApplicationEngine(options);
    engine.releaseLock = await acquireStateLock(options.stateDirectory);
    try {
    const ids = new Set<string>();
    for (const root of engine.roots) {
      if (!root.id || ids.has(root.id) || !root.label || !path.isAbsolute(root.path)) throw new Error("Invalid download roots.");
      ids.add(root.id);
      root.aliasPath = path.resolve(root.path);
      root.path = await fs.realpath(root.path);
      if (!(await fs.stat(root.path)).isDirectory()) throw new Error("Invalid download root.");
    }
    if (options.stagingDirectory !== undefined) {
      if (!path.isAbsolute(options.stagingDirectory)) throw new Error("Invalid staging directory.");
      engine.stagingRoot = await fs.realpath(options.stagingDirectory);
      if (process.platform === "win32" && engine.stagingRoot.startsWith("\\\\")) throw new Error("Staging must use engine-local storage.");
      await ensureSafeDirectory(engine.stagingRoot, engine.stagingRoot, false);
    }
    await engine.store.load();
    let stagingConfigurationChanged = false;
    if (engine.roots.length) {
      const previous = engine.store.settings.stagingDirectory, configured = engine.stagingRoot ?? "";
      if ((previous && (!configured || !samePath(previous, configured))) || (!previous && engine.store.settings.stageDownloads)) {
        engine.store.settings.stageDownloads = false; engine.store.settings.stagingDirectory = configured; stagingConfigurationChanged = true;
      } else if (configured && !previous) engine.store.settings.stagingDirectory = configured;
    }
    if (options.token !== undefined) engine.store.token = options.token;
    try {
      const loaded = JSON.parse(await fs.readFile(path.join(options.stateDirectory, "engine.json"), "utf8"));
      if (loaded.version !== 1 || typeof loaded.id !== "string" || typeof loaded.paused !== "boolean" || (loaded.stagingNotice !== undefined && (typeof loaded.stagingNotice !== "string" || loaded.stagingNotice.length > 300)) || !Array.isArray(loaded.jobs) || !loaded.descriptions || !loaded.receipts) throw new Error();
      engine.state = loaded;
    } catch (error: any) { if (error.code !== "ENOENT") throw new Error("Could not read engine state."); }
    if (stagingConfigurationChanged) {
      engine.state.stagingNotice = "The server staging directory changed. Staging is off; review the path and re-enable it for new downloads.";
    }
    if (!engine.roots.length) {
      for (const dir of [engine.store.settings.downloadDirectory, engine.store.settings.stagingDirectory, ...engine.store.rules.map(rule => rule.downloadDirectory)].filter(Boolean)) {
        const resolved = path.resolve(dir);
        const canonical = await fs.realpath(resolved).catch(() => resolved);
        engine.allowed.set(pathIdentity(resolved), canonical); engine.allowed.set(pathIdentity(canonical), canonical);
      }
    } else {
      for (const dir of [engine.store.settings.downloadDirectory, ...engine.store.rules.map(r => r.downloadDirectory)].filter(Boolean)) await engine.validateDirectory(dir);
    }
    engine.state.recovery ??= {};
    engine.queue.recovery = engine.state.recovery;
    engine.queue.paused = true;
    const stagingProbeBlocked = !!engine.state.stagingProbe && !await engine.reconcileStagingProbe(false);
    const anchorReleases: { job: DownloadJob; recovery: DownloadRecovery }[] = [];
    const stageReleases: { job: DownloadJob; recovery: DownloadRecovery }[] = [];
    for (const job of engine.state.jobs) {
      if (!job || typeof job.id !== "string" || typeof job.fileId !== "string" || typeof job.destination !== "string" || typeof job.status !== "string") throw new Error("Invalid saved job.");
      delete job.cleanupPending;
      const description = engine.state.descriptions[job.id];
      if (job.status === "cleaning") { job.status = "completed"; job.error = "Downloaded locally; remote cleanup outcome is unknown."; }
      if (["downloading", "copying", "recovering", "finalizing", "restarting"].includes(job.status)) { job.status = "interrupted"; job.error = "Interrupted by engine restart; retry explicitly."; job.speed = 0; }
      let valid = false;
      if (description) {
        try {
          if (!description.file || description.file.id !== job.fileId || typeof description.file.name !== "string" || typeof description.zip !== "boolean" || typeof description.cleanup !== "boolean") throw new Error();
          const originalRoot = description.root;
          const root = await engine.validateDirectory(originalRoot);
          if (typeof description.dir !== "string" || !path.isAbsolute(description.dir)) throw new Error();
          const rel = path.relative(originalRoot, description.dir);
          if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error();
          const expected = path.join(await fs.realpath(root), rel, safeName(description.file.name));
          if (!samePath(expected, job.destination)) throw new Error();
          description.root = root; description.dir = path.join(root, rel);
          valid = true;
        } catch { delete engine.state.descriptions[job.id]; }
      }
      const recovery = engine.state.recovery[job.id];
      const releasePending = !!recovery?.delivery && (!!recovery.delivery.destinationAnchorRelease || !!recovery.delivery.retiredDestinations?.some(item => item.release) || (!!recovery.delivery.stageAnchorRelease && recovery.finalization?.phase !== "published"));
      if (recovery?.delivery && !releasePending) delete job.verification;
      const stagingBlockedByClose = !!recovery?.delivery && engine.queue.hasUncertainOpen();
      let stagingValid = !(stagingProbeBlocked && !!recovery?.delivery) && !stagingBlockedByClose;
      if (valid && stagingValid) { try { await engine.validateStagingDescription(description, recovery); } catch { stagingValid = false; } }
      const closeOwner = recovery?.closeUncertainProcess;
      const previousProcess = valid && typeof closeOwner === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(closeOwner) && closeOwner !== downloadProcessInstance;
      if (previousProcess && recovery) {
        delete recovery.closeUncertainProcess;
        job.status = recovery.intent === "run" ? "needs-attention" : "interrupted";
        job.error = recovery.intent === "run" ? "Download file needs an explicit retry." : undefined;
      } else if (closeOwner !== undefined) { job.status = "needs-attention"; job.error = "Download file could not be safely closed."; job.speed = 0; }
      if (recovery?.delivery && releasePending) {
        if (valid && stagingValid && ["completed", "unverified", "canceled", "needs-attention"].includes(job.status) && recovery.closeUncertainProcess === undefined) anchorReleases.push({ job, recovery });
        else { job.status = "needs-attention"; job.error = "Saved staging anchor release requires attention."; }
        engine.queue.jobs.push(job); continue;
      }
      if (valid && stagingValid && recovery?.delivery?.stageAnchorRelease && recovery.closeUncertainProcess === undefined) stageReleases.push({ job, recovery });
      if (closeOwner === undefined && recovery?.finalization && ["interrupted", "needs-attention", "completed", "unverified"].includes(job.status)) {
        if (valid && stagingValid) await recoverPublished(job, description.root, recovery, (_role, handle, settlement) => engine.queue.retainUncertain(job.id, handle, settlement), options.stagedCloseAdapter);
        else { job.status = "needs-attention"; job.error = "Published destination could not be verified."; job.speed = 0; }
        if (valid && stagingValid && recovery.delivery && ["completed", "unverified"].includes(job.status)) {
          recovery.delivery.phase = "stage-cleanup-pending";
          try { if (!recovery.delivery.stageAnchorRelease) await discardOwnedStage(recovery, (_role, handle, settlement) => engine.queue.retainUncertain(job.id, handle, settlement), options.stagedCloseAdapter); job.stagingWarning = undefined; }
          catch (error) { if (await engine.queue.retainCloseError(job.id, error)) throw error; job.stagingWarning = "The verified output is safe, but its staged copy could not be removed."; }
        }
      }
      const invalidWaiting = job.status === "waiting" && (!valid || !recovery || recovery.version !== 1 || !["run", "paused", "canceled"].includes(recovery.intent) || !Number.isSafeInteger(recovery.retryCount) || (recovery.retryCount ?? 0) < 1 || typeof recovery.retryAt !== "string" || !Number.isFinite(Date.parse(recovery.retryAt)) || recovery.retryAt !== job.retryAt);
      if (invalidWaiting) {
        job.status = "interrupted"; job.error = "Saved recovery state requires attention."; job.speed = 0;
      }
      if (valid && stagingValid && ["interrupted", "paused", "canceled", "waiting"].includes(job.status) && recovery?.intent === "canceled" && recovery.closeUncertainProcess === undefined && !recovery.finalization) {
        job.status = "canceled"; job.speed = 0;
        try { await discardOwnedPartial(job, description.root, recovery, (_role, handle, settlement) => engine.queue.retainUncertain(job.id, handle, settlement), options.stagedCloseAdapter); if (recovery.delivery) await discardOwnedStage(recovery, (_role, handle, settlement) => engine.queue.retainUncertain(job.id, handle, settlement), options.stagedCloseAdapter); job.bytesReceived = 0; job.error = undefined; }
        catch (error) { if (await engine.queue.retainCloseError(job.id, error)) throw error; if (recovery.delivery) job.status = "needs-attention"; job.error = "Canceled partial could not be safely removed."; }
      }
      if (valid && stagingValid && ["interrupted", "waiting"].includes(job.status) && recovery?.intent === "paused" && recovery.closeUncertainProcess === undefined && !recovery.finalization) {
        job.status = "paused"; job.error = undefined;
      }
      if (valid && stagingValid && !invalidWaiting && job.status === "interrupted" && recovery?.intent === "run" && recovery.closeUncertainProcess === undefined && !recovery.finalization) {
        job.status = engine.state.paused ? "paused" : "queued"; job.error = undefined;
      }
      if (job.status === "queued" && !valid) { job.status = "interrupted"; job.error = "Saved job destination is no longer allowed."; }
      if (!stagingValid) { job.status = "needs-attention"; job.error = stagingBlockedByClose ? "A staged file close is unresolved; exit the engine if it cannot be reconciled." : "Saved staging configuration or recovery requires attention."; job.speed = 0; }
      if (valid && stagingValid) {
        engine.queue.restore(job, description.root, engine.source(description), engine.cleanup(description, job.id), description.zip ? "zip" : "file", engine.sourceIdentity(description));
        if (recovery?.delivery && recovery.closeUncertainProcess === undefined && !job.stagingWarning && ((["completed", "unverified"].includes(job.status) && (!recovery.cleanup || recovery.cleanup.phase !== "in-flight")) || (job.status === "canceled" && recovery.intent === "canceled" && !recovery.finalization && !job.error))) anchorReleases.push({ job, recovery });
      }
      else engine.queue.jobs.push(job);
    }
    if (stagingProbeBlocked) {
      engine.store.settings.stageDownloads = false; stagingConfigurationChanged = true;
      engine.state.stagingNotice = "A previous staging directory check requires inspection. Staging is off.";
      for (const job of engine.queue.jobs) if (engine.state.recovery?.[job.id]?.delivery && !["completed", "unverified", "canceled"].includes(job.status)) { job.status = "needs-attention"; job.error = "A staging directory check requires inspection."; job.speed = 0; }
    }
    await engine.persist();
    for (const { job, recovery } of stageReleases) {
      if (anchorReleases.some(item => item.job.id === job.id)) continue;
      try { await releaseStageAnchor(recovery, () => engine.persist(), (_role, handle, settlement) => engine.queue.retainUncertain(job.id, handle, settlement), options.stagedCloseAdapter); job.stagingWarning = undefined; }
      catch (error) { if (await engine.queue.retainCloseError(job.id, error)) throw error; job.status = "needs-attention"; job.error = "Staging anchor cleanup requires attention."; await engine.persist(); }
    }
    for (const { job, recovery } of anchorReleases) {
      try { await releaseStagedAnchors(job, recovery, () => engine.persist(), (_role, handle, settlement) => engine.queue.retainUncertain(job.id, handle, settlement), options.stagedCloseAdapter); }
      catch (error) { if (await engine.queue.retainCloseError(job.id, error)) throw error; job.status = "needs-attention"; job.error = "Staging anchor cleanup requires attention."; await engine.persist(); }
    }
    if (stagingConfigurationChanged) await engine.store.save();
    engine.queue.paused = engine.state.paused;
    engine.queue.pump();
    engine.resetTimer();
    if (engine.store.token) {
      engine.connection = { status: "checking" };
      void engine.api.validateToken(engine.store.token).then(() => { if (!engine.closed) { engine.connection = { status: "connected" }; engine.emit(); } }, () => { if (!engine.closed) { engine.connection = { status: "error", message: "Could not validate the saved account." }; engine.emit(); } });
    }
    return engine;
    } catch (error) {
      if (engine.queue.hasUncertainOpen()) {
        engine.closed = true; engine.queue.paused = true;
        throw new EngineStartupFailure({ close: () => engine.close() }, error);
      }
      await engine.releaseLock?.(); throw error;
    }
  }
  private ensureOpen() { if (this.closed) throw new Error("Engine is closed."); }
  private track<T>(work: Promise<T>): Promise<T> { this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work; }
  allowDirectory(dir: string) { if (this.roots.length || !path.isAbsolute(dir)) throw new Error("Directory selection is unavailable."); const resolved = path.resolve(dir); const canonical = realpathSync.native(resolved); this.allowed.set(pathIdentity(resolved), canonical); this.allowed.set(pathIdentity(canonical), canonical); }
  private async validateDirectory(value: unknown): Promise<string> {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Choose an allowed download directory.");
    const dir = path.resolve(value);
    if (!this.roots.length) {
      const canonical = this.allowed.get(pathIdentity(dir));
      if (!canonical) throw new Error("Choose a directory using the directory picker.");
      if (!samePath(await fs.realpath(dir), canonical)) throw new Error("Unsafe download root.");
      await ensureSafeDirectory(canonical, canonical);
      return canonical;
    }
    const contained = (base: string) => { const rel = path.relative(base, dir); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
    const root = this.roots.find(r => contained(r.path) || (r.aliasPath && contained(r.aliasPath)));
    if (!root) throw new Error("Download directory is outside configured roots.");
    const relative = path.relative(contained(root.path) ? root.path : root.aliasPath!, dir);
    const rootStat = await fs.lstat(root.path);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !samePath(await fs.realpath(root.path), root.path)) throw new Error("Unsafe download root.");
    let current = root.path;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe download directory.");
    }
    return path.join(root.path, relative);
  }
  private async reconcileStagingProbe(persist: boolean): Promise<boolean> {
    const probe = this.state.stagingProbe;
    if (!probe) return true;
    try {
      if (!path.isAbsolute(probe.root) || !/^\.putio-probe-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(probe.name) || !/^\d+$/.test(probe.rootDev) || !/^\d+$/.test(probe.rootIno)) return false;
      const authorized = this.roots.length ? this.stagingRoot : await this.validateDirectory(probe.root);
      if (!authorized || !samePath(authorized, probe.root)) return false;
      await ensureSafeDirectory(probe.root, probe.root, false);
      const root = await fs.lstat(probe.root, { bigint: true });
      if (String(root.dev) !== probe.rootDev || String(root.ino) !== probe.rootIno) return false;
      const candidate = path.join(probe.root, probe.name);
      const stat = await fs.lstat(candidate, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (stat) {
        if (!probe.owned || !stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== probe.owned.dev || String(stat.ino) !== probe.owned.ino) return false;
        await fs.rmdir(candidate);
      }
      delete this.state.stagingProbe;
      if (persist) await this.persist();
      return true;
    } catch { return false; }
  }
  private async verifyStagingWritable(root: string): Promise<void> {
    if (!await this.reconcileStagingProbe(true)) throw new Error("A previous staging check requires inspection.");
    await ensureSafeDirectory(root, root, false);
    const rootStat = await fs.lstat(root, { bigint: true });
    const probe: StagingProbe = { root, rootDev: String(rootStat.dev), rootIno: String(rootStat.ino), name: `.putio-probe-${randomUUID()}` };
    this.state.stagingProbe = probe; await this.persist();
    let created = false;
    try {
      await ensureSafeDirectory(root, root, false);
      const currentRoot = await fs.lstat(root, { bigint: true });
      if (String(currentRoot.dev) !== probe.rootDev || String(currentRoot.ino) !== probe.rootIno) throw new Error("Unsafe staging root.");
      const candidate = path.join(root, probe.name); await fs.mkdir(candidate, { mode: 0o700 }); created = true;
      const stat = await fs.lstat(candidate, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe staging check.");
      probe.owned = { dev: String(stat.dev), ino: String(stat.ino) }; await this.persist();
      if (!await this.reconcileStagingProbe(true)) throw new Error("Staging check could not be safely removed.");
    } catch (error) {
      if (!created && (error as NodeJS.ErrnoException).code !== "EEXIST") { delete this.state.stagingProbe; await this.persist(); }
      throw new Error("Could not verify that the staging directory is writable; inspect its permissions.");
    }
  }
  private async validateStagingDescription(d: Description, record?: DownloadRecovery): Promise<void> {
    const staged = d.staging, delivery = record?.delivery;
    if (!staged && !delivery) return;
    if (!staged || !delivery || typeof staged.root !== "string" || !path.isAbsolute(staged.root) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this.state.id) || staged.namespace !== `.putio-${this.state.id}` || !Number.isSafeInteger(staged.maxBytes) || staged.maxBytes <= 0 || !Number.isSafeInteger(staged.minimumFreeBytes) || staged.minimumFreeBytes < 0) throw new Error("Saved staging policy requires attention.");
    const allowed = this.roots.length ? this.stagingRoot : await this.validateDirectory(staged.root);
    if (!allowed || !samePath(allowed, staged.root) || !samePath(await fs.realpath(staged.root), staged.root)) throw new Error("Saved staging directory is no longer authorized.");
    await ensureSafeDirectory(staged.root, staged.root, false);
    const stageStat = await fs.lstat(staged.root, { bigint: true });
    if (!/^\d+$/.test(staged.rootDev) || !/^\d+$/.test(staged.rootIno) || String(stageStat.dev) !== staged.rootDev || String(stageStat.ino) !== staged.rootIno) throw new Error("Saved staging root was replaced.");
    const within = (base: string, value: string) => { const rel = path.relative(base, value); return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
    if (within(staged.root, d.dir) || within(d.dir, staged.root)) throw new Error("Saved staging directory conflicts with its destination.");
    if (!samePath(delivery.root, staged.root) || delivery.rootDev !== staged.rootDev || delivery.rootIno !== staged.rootIno || delivery.namespace !== staged.namespace || delivery.maxBytes !== staged.maxBytes || delivery.minimumFreeBytes !== staged.minimumFreeBytes || !/^\.putio-[0-9a-f-]+\.download$/i.test(delivery.name) || !["downloading-stage", "stage-ready", "copying", "destination-prepared", "published", "stage-cleanup-pending"].includes(delivery.phase)) throw new Error("Saved staging recovery requires attention.");
    if (delivery.owned && (!/^\d+$/.test(delivery.owned.dev) || !/^\d+$/.test(delivery.owned.ino) || delivery.owned.anchor?.name !== `${delivery.name}.anchor` || delivery.owned.anchor.namespace !== undefined)) throw new Error("Saved staging ownership requires attention.");
    if (record?.owned && (!/^\d+$/.test(record.owned.dev) || !/^\d+$/.test(record.owned.ino) || record.owned.anchor?.name !== `${record.partial}.anchor` || record.owned.anchor.namespace !== delivery.namespace)) throw new Error("Saved destination ownership requires attention.");
    if ((delivery.stageAnchorRelease !== undefined && (!delivery.owned || !["pending", "released"].includes(delivery.stageAnchorRelease))) || (delivery.destinationAnchorRelease !== undefined && (!record?.owned || !["pending", "released"].includes(delivery.destinationAnchorRelease)))) throw new Error("Saved anchor release requires attention.");
    if (delivery.retiredDestinations !== undefined && (!Array.isArray(delivery.retiredDestinations) || delivery.retiredDestinations.some(item => !item || !/^\.putio-[0-9a-f-]+\.download$/i.test(item.name) || !/^\d+$/.test(item.owned?.dev ?? "") || !/^\d+$/.test(item.owned?.ino ?? "") || item.owned?.anchor?.name !== `${item.name}.anchor` || item.owned.anchor.namespace !== delivery.namespace || (item.release !== undefined && !["pending", "released"].includes(item.release))))) throw new Error("Saved retired destination ownership requires attention.");
    const retiredNames = delivery.retiredDestinations?.map(item => item.name) ?? [];
    if (new Set(retiredNames).size !== retiredNames.length || retiredNames.includes(record?.partial ?? "")) throw new Error("Saved retired destination ownership requires attention.");
    if (!delivery.destinationAnchorRelease && !delivery.retiredDestinations?.some(item => item.release)) {
      const { verifyArtifactAnchor } = await import("../core/staged-delivery.js");
      if (delivery.owned && !delivery.stageAnchorRelease) await verifyArtifactAnchor({ root: path.join(delivery.root, delivery.namespace), name: delivery.name, owned: delivery.owned });
      if (record?.owned) await verifyArtifactAnchor({ root: d.dir, name: record.partial, owned: record.owned });
      for (const retired of delivery.retiredDestinations ?? []) await verifyArtifactAnchor({ root: d.dir, name: retired.name, owned: retired.owned });
    }
    if (delivery.zipContentsVerified !== undefined && typeof delivery.zipContentsVerified !== "boolean") throw new Error("Saved staging evidence requires attention.");
    if (["destination-prepared", "published", "stage-cleanup-pending"].includes(delivery.phase) && (!record?.finalization || !record.owned || record.owned.dev !== record.finalization.dev || record.owned.ino !== record.finalization.ino)) throw new Error("Saved staging finalization requires attention.");
    if (["stage-ready", "copying", "destination-prepared", "published", "stage-cleanup-pending"].includes(delivery.phase)) {
      const source = record?.source;
      if (!source || source.id !== d.file.id || source.kind !== (d.zip ? "zip" : "file") || !Number.isSafeInteger(delivery.length) || delivery.length! < 0 || !/^[0-9a-f]{64}$/i.test(delivery.sha256 ?? "") || !["verified", "unverified"].includes(delivery.verification ?? "") || (source.expectedBytes !== undefined && (!Number.isSafeInteger(source.expectedBytes) || source.expectedBytes < 0 || source.expectedBytes !== delivery.length)) || (delivery.verification === "verified" && source.expectedBytes === undefined) || (source.sha1 !== undefined && !/^[0-9a-f]{40}$/i.test(source.sha1)) || (source.crc32 !== undefined && !/^[0-9a-f]{8}$/i.test(source.crc32))) throw new Error("Saved staging evidence requires attention.");
    }
  }
  private sourceIdentity(d: Description) { return (signal: AbortSignal) => this.api.getFile(d.file.id, signal); }
  private source(d: Description) { return async (signal: AbortSignal) => {
    if (d.zip) return this.api.zipSource(d.file.id, 120, 1000, signal);
    const file = await this.api.getFile(d.file.id, signal);
    const url = await this.api.downloadUrl(d.file.id, signal);
    return { url, file, ...(file.sizeKnown ? { expectedBytes: file.size } : {}), crc32: file.crc32, sha1: file.sha1 };
  }; }
  private cleanup(d: Description, jobId: string) {
    if (!d.cleanup) return undefined;
    return async () => {
      this.ensureOpen(); await this.api.deleteFile(d.file.id); this.ensureOpen();
      if (d.deleteSourceFolders && !d.file.isFolder && !d.zip && d.folderCleanup) {
        let pending = false;
        for (const folderId of [...d.folderCleanup.ancestry].reverse()) {
          if (folderId !== "0" && folderId !== d.folderCleanup.ruleRoot) { this.folderCandidates.set(`${jobId}:${folderId}`, { jobId, folderId, description: d }); pending = true; }
        }
        return pending;
      }
      return false;
    };
  }
  private enqueue(d: Description, receipt?: { requestId: string; fingerprint: string }, explicit = false): Promise<string> {
    const operation = this.enqueueWrites.catch(() => {}).then(async () => {
      this.ensureOpen();
      const originalRoot = d.root;
      const relative = path.relative(originalRoot, d.dir);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Download directory is outside its selected root.");
      d.root = await this.validateDirectory(originalRoot);
      d.dir = path.join(d.root, relative);
      if (this.store.settings.stageDownloads) {
        const stage = this.roots.length ? this.stagingRoot : await this.validateDirectory(this.store.settings.stagingDirectory);
        if (!stage || !samePath(await fs.realpath(stage), stage)) throw new Error("Staging directory is not authorized.");
        const within = (base: string, value: string) => { const rel = path.relative(base, value); return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
        if (within(stage, d.dir) || within(d.dir, stage)) throw new Error("Staging directory must be separate from the download directory.");
        const stageStat = await fs.lstat(stage, { bigint: true });
        d.staging = { root: stage, rootDev: String(stageStat.dev), rootIno: String(stageStat.ino), namespace: `.putio-${this.state.id}`, maxBytes: this.store.settings.stagingMaxBytes, minimumFreeBytes: this.store.settings.stagingMinimumFreeBytes };
      }
      this.ensureOpen();
      this.queue.paused = true;
      this.accepting = true;
      const proposed = randomUUID();
      this.state.descriptions[proposed] = d;
      try {
        const jobId = await this.queue.enqueue(d.file, d.dir, this.source(d), this.cleanup(d, proposed), d.root, proposed, { deleteAfterDownload: d.cleanup, deleteSourceFolders: d.deleteSourceFolders ?? false, speedLimitBytesPerSecond: d.speedLimitBytesPerSecond ?? 0, staging: d.staging }, d.root, explicit, d.zip ? "zip" : "file", () => explicit || !this.state.paused, this.sourceIdentity(d));
        if (this.closed) { if (jobId === proposed) this.queue.cancel([jobId]); delete this.state.descriptions[proposed]; throw new Error("Engine is closed."); }
        if (jobId !== proposed) delete this.state.descriptions[proposed];
        if (receipt) this.state.receipts[receipt.requestId] = { fingerprint: receipt.fingerprint, jobId };
        try { await this.persist(); } catch (error) {
          if (jobId === proposed) this.queue.cancel([jobId]);
          if (receipt) delete this.state.receipts[receipt.requestId];
          throw error;
        }
        return jobId;
      } finally { this.accepting = false; this.queue.paused = this.closed || this.state.paused; if (!this.closed) { this.queue.pump(); this.emit(); } }
    });
    this.enqueueWrites = operation; return operation;
  }
  private persist(): Promise<void> {
    this.state.jobs = structuredClone(this.queue.jobs);
    const json = JSON.stringify(this.state);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(this.options.stateDirectory, { recursive: true });
      const file = path.join(this.options.stateDirectory, "engine.json");
      await fs.writeFile(file + ".tmp", json, { mode: 0o600 });
      await fs.rename(file + ".tmp", file);
    });
    return this.writes;
  }
  private queueChanged() {
    if (this.closed || this.accepting) return;
    this.scheduleFolderCleanup();
    const states = this.queue.jobs.map(j => `${j.id}:${j.status}`).join("|");
    if (states !== this.jobStates) {
      this.jobStates = states;
      const persisted = this.persist().catch(() => { this.connection = { status: "error", message: "Could not save engine state." }; this.emit(); throw new Error("Could not save engine state."); });
      this.emit();
      return persisted;
    } else if (!this.progressTimer) this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      void this.persist().catch(() => { this.connection = { status: "error", message: "Could not save engine state." }; this.emit(); });
      this.emit();
    }, 1000);
  }
  private ruleStillMatches(details: FolderCleanup): boolean {
    if (!details.ruleId) return true;
    const rule = this.store.rules.find(item => item.id === details.ruleId);
    return !!rule && rule.folderId === details.ruleRoot && rule.minSizeBytes === details.minSizeBytes && JSON.stringify(rule.extensions) === JSON.stringify(details.extensions);
  }
  private folderOutcome(jobId: string, phase: "not-started" | "in-flight" | "succeeded" | "failed" | "unknown") {
    const job = this.queue.jobs.find(item => item.id === jobId), record = this.state.recovery?.[jobId];
    if (!job || !record?.cleanup || record.cleanup.phase === "unknown" || record.cleanup.phase === "failed") return;
    record.cleanup = { phase, step: "folder" };
    if (phase !== "in-flight") {
      job.cleanupStatus = phase;
      job.cleanupWarning = phase === "succeeded" ? undefined : phase === "failed" ? "Source folder cleanup failed." : phase === "unknown" ? "Source folder cleanup outcome is unknown." : "Source folder cleanup was not completed.";
    }
  }
  private async verifyStagedFolderDestination(job: DownloadJob, record: DownloadRecovery, root: string): Promise<void> {
    const delivery = record.delivery, evidence = record.finalization;
    if (!delivery || !evidence || !record.owned || record.owned.dev !== evidence.dev || record.owned.ino !== evidence.ino || delivery.destinationAnchorRelease) throw new Error("Staged destination ownership requires attention.");
    const directory = path.dirname(job.destination), { verifyArtifactAnchor, closeArtifact } = await import("../core/staged-delivery.js");
    await ensureSafeDirectory(root, directory, false);
    await verifyArtifactAnchor({ root: directory, name: record.partial, owned: record.owned });
    const handle = await fs.open(job.destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let length = 0;
      while (true) { const read = await handle.read(buffer, 0, buffer.length, length); if (!read.bytesRead) break; hash.update(buffer.subarray(0, read.bytesRead)); length += read.bytesRead; }
      const opened = await handle.stat({ bigint: true }), current = await fs.lstat(job.destination, { bigint: true });
      await ensureSafeDirectory(root, directory, false); await verifyArtifactAnchor({ root: directory, name: record.partial, owned: record.owned });
      if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || String(opened.dev) !== evidence.dev || String(opened.ino) !== evidence.ino || String(current.dev) !== evidence.dev || String(current.ino) !== evidence.ino || length !== evidence.length || Number(opened.size) !== length || Number(current.size) !== length || hash.digest("hex") !== evidence.sha256) throw new Error("Staged destination could not be verified.");
    } finally { await closeArtifact(handle, "destination", (_role, uncertain, settlement) => this.queue.retainUncertain(job.id, uncertain, settlement), this.options.stagedCloseAdapter); }
  }
  private async releaseSettledFolderAnchors(): Promise<void> {
    for (const job of this.queue.jobs) {
      let record = this.state.recovery?.[job.id];
      if (!record?.delivery || record.cleanup?.step !== "folder" || record.cleanup.phase === "in-flight" || job.status !== "completed" || job.stagingWarning || [...this.folderCandidates.values()].some(candidate => candidate.jobId === job.id)) continue;
      await this.queue.waitUntilInactive(job.id);
      record = this.state.recovery?.[job.id];
      if (this.closed || this.queue.hasUncertainOpen() || !record?.delivery || record.closeUncertainProcess !== undefined || record.cleanup?.step !== "folder" || record.cleanup.phase === "in-flight" || job.status !== "completed" || job.stagingWarning || [...this.folderCandidates.values()].some(candidate => candidate.jobId === job.id)) continue;
      if (record.delivery.stageAnchorRelease === "released" && (!record.owned || record.delivery.destinationAnchorRelease === "released") && !record.delivery.retiredDestinations?.some(item => item.release !== "released")) continue;
      try { await this.persist(); await releaseStagedAnchors(job, record, () => this.persist(), (_role, handle, settlement) => this.queue.retainUncertain(job.id, handle, settlement), this.options.stagedCloseAdapter); }
      catch (error) { await this.queue.retainCloseError(job.id, error); job.stagingWarning = "The verified output is safe, but its staging anchor needs inspection."; await this.persist().catch(() => {}); }
    }
  }
  private scheduleFolderCleanup() {
    if (this.closed || !this.folderCandidates.size) return;
    if (this.folderDrain) { this.folderDrainRequested = true; return; }
    const work = (async () => {
      try { await this.scanner.whenIdle(); }
      catch { for (const candidate of this.folderCandidates.values()) this.folderOutcome(candidate.jobId, "failed"); this.folderCandidates.clear(); await this.persist(); this.emit(); return; }
      for (const [key, candidate] of this.folderCandidates) {
        if (this.closed) return;
        const job = this.queue.jobs.find(item => item.id === candidate.jobId);
        if (!job || job.status !== "completed" || job.error || job.cleanupStatus !== "not-started") continue;
        const details = candidate.description.folderCleanup!;
        if (!this.ruleStillMatches(details) || (details.ruleId && this.scanStatus !== "idle")) { this.folderCandidates.delete(key); this.folderOutcome(job.id, "not-started"); await this.persist(); this.emit(); continue; }
        let dispatched = false;
        let affected = [job.id];
        try {
          const generation = this.rulesGeneration;
          const protectedRoots = new Set(this.store.rules.map(rule => rule.folderId));
          if (candidate.folderId === "0" || protectedRoots.has(candidate.folderId)) { this.folderCandidates.delete(key); this.folderOutcome(job.id, "not-started"); await this.persist(); this.emit(); continue; }
          const folder = await this.api.getFile(candidate.folderId, this.shutdownSignal.signal);
          if (!folder.isFolder || folder.id !== candidate.folderId) throw new Error("Invalid source folder.");
          const ancestors = details.ancestry;
          const position = ancestors.indexOf(candidate.folderId);
          const expectedParent = position > 0 ? ancestors[position - 1] : details.ruleRoot;
          if (expectedParent && folder.parentId !== expectedParent) throw new Error("Source folder moved.");
          const folders = new Set<string>(), files = new Set<string>();
          const extensions = details.extensions.map(ext => ext.toLowerCase().replace(/^\./, ""));
          let eligible = false, protectedFolder = false;
          const visit = async (folderId: string): Promise<void> => {
            if (folders.has(folderId)) throw new Error("Folder cycle encountered.");
            folders.add(folderId);
            if (protectedRoots.has(folderId)) protectedFolder = true;
            for (const file of await this.api.listFiles(folderId, this.shutdownSignal.signal)) {
              if (file.parentId !== folderId || !/^\d{1,20}$/.test(file.id)) throw new Error("Ambiguous folder contents.");
              if (file.isFolder) await visit(file.id);
              else {
                files.add(file.id);
                if (file.size >= details.minSizeBytes && (!extensions.length || extensions.includes(path.extname(file.name).slice(1).toLowerCase()))) eligible = true;
              }
            }
          };
          await visit(candidate.folderId);
          const blocked = this.queue.jobs.some(other => {
            const d = this.state.descriptions[other.id];
            const related = files.has(other.fileId) || !!d && (folders.has(d.file.parentId) || (d.folderCleanup?.ancestry ?? []).some(folderId => folders.has(folderId)));
            if (!related) return false;
            // Explicit folder Keep protects that source subtree even after its file was removed.
            if (d?.folderCleanupKeep) return true;
            // A completed Keep-file job protects its still-present source, even if this rule excludes it.
            if (d && !d.cleanup && files.has(other.fileId)) return true;
            return other.status !== "completed" || !!other.error;
          });
          if (blocked) continue;
          if (eligible || protectedFolder || this.closed || this.state.paused || this.state.recovery?.[candidate.jobId]?.intent !== "run" || this.scanStatus === "scanning" || this.rulesGeneration !== generation || !this.ruleStillMatches(details) || this.store.rules.some(rule => folders.has(rule.folderId))) { this.folderCandidates.delete(key); this.folderOutcome(job.id, "not-started"); await this.persist(); this.emit(); continue; }
          affected = [...new Set([...this.folderCandidates.values()].filter(other => folders.has(other.folderId)).map(other => other.jobId))];
          for (const id of affected) this.folderOutcome(id, "in-flight");
          await this.persist();
          if (this.closed || this.state.paused || affected.some(id => this.state.recovery?.[id]?.intent !== "run") || this.scanStatus === "scanning" || this.rulesGeneration !== generation || !this.ruleStillMatches(details) || this.store.rules.some(rule => folders.has(rule.folderId))) {
            for (const id of affected) this.folderOutcome(id, "not-started");
            this.folderCandidates.delete(key); await this.persist(); this.emit(); continue;
          }
          for (const id of affected) {
            const completed = this.queue.jobs.find(item => item.id === id), record = this.state.recovery?.[id], description = this.state.descriptions[id];
            if (record?.delivery) { if (!completed || !description) throw new Error("Staged destination is unavailable."); await this.verifyStagedFolderDestination(completed, record, description.root); }
          }
          if (this.closed || this.state.paused || affected.some(id => this.state.recovery?.[id]?.intent !== "run")) {
            for (const id of affected) this.folderOutcome(id, "not-started");
            this.folderCandidates.delete(key); await this.persist(); this.emit(); continue;
          }
          // The provider exposes no conditional delete; a remote addition after this scan can race this request.
          dispatched = true;
          await this.api.deleteFile(candidate.folderId);
          for (const [otherKey, other] of this.folderCandidates) if (folders.has(other.folderId)) this.folderCandidates.delete(otherKey);
          for (const id of affected) this.folderOutcome(id, [...this.folderCandidates.values()].some(other => other.jobId === id) ? "not-started" : "succeeded");
          try { await this.persist(); } catch (error) { for (const id of affected) this.folderOutcome(id, "unknown"); throw error; }
          this.emit();
        } catch (error) {
          this.folderCandidates.delete(key);
          const definite = !dispatched || error instanceof PutioRequestError && [400, 401, 403].includes(error.status ?? 0);
          if (!this.closed) { for (const id of affected) this.folderOutcome(id, definite ? "failed" : "unknown"); await this.persist().catch(() => {}); this.emit(); }
        }
      }
    })().finally(() => this.releaseSettledFolderAnchors());
    this.folderDrain = work;
    this.track(work);
    void work.finally(() => { if (this.folderDrain === work) this.folderDrain = undefined; if (this.folderDrainRequested) { this.folderDrainRequested = false; this.scheduleFolderCleanup(); } }).catch(() => {});
  }
  private emit() { this.revision++; const snapshot = this.snapshot(); for (const listener of this.listeners) { try { listener(structuredClone(snapshot)); } catch { /* subscriber is isolated */ } } }
  private snapshot(): EngineSnapshot { return { fileMovesSupported: true, settings: { ...this.store.settings }, hasToken: !!this.store.token, secureStorageAvailable: this.options.credentials.available(), rules: structuredClone(this.store.rules), jobs: this.queue.jobs.map(job => { const copy = structuredClone(job); delete copy.cleanupPending; const record = this.state.recovery?.[job.id]; if (!this.closed && job.status === "completed" && record?.intent === "run" && record.cleanup?.step === "folder" && ["not-started", "in-flight"].includes(record.cleanup.phase) && [...this.folderCandidates.values()].some(candidate => candidate.jobId === job.id)) copy.cleanupPending = true; return copy; }), scanStatus: this.scanStatus, stagingNotice: this.state.stagingNotice, engine: { id: this.state.id, label: this.options.label ?? "Local", protocolVersion: 2, epoch: this.epoch, revision: this.revision }, connection: { ...this.connection }, paused: this.state.paused, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, nextRuleRuns: Object.fromEntries(Object.entries(this.nextRuns).map(([key, value]) => [key, new Date(value).toISOString()])), roots: this.roots.map(({ id, label }) => ({ id, label })) }; }
  async getSnapshot() { return this.snapshot(); }
  subscribe(listener: (snapshot: EngineSnapshot) => void, _onError?: (error: Error) => void) { this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener); }; }
  private now() { return (this.options.now ?? (() => new Date()))().getTime(); }
  private nextRun(rule: AutoDownloadRule, after: number): number {
    const schedule = rule.schedule;
    if (!schedule || schedule.kind === "interval") return after + (schedule?.seconds ?? this.store.settings.autoDownloadInterval) * 1000;
    const [hour, minute] = schedule.time.split(":").map(Number);
    const base = new Date(after);
    for (let offset = 0; offset <= 14; offset++) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12);
      if (schedule.kind === "weekly" && day.getDay() !== schedule.day) continue;
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
      // Nonexistent wall times are skipped; Date chooses only the first repeated wall time.
      if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
      if (candidate.getTime() > after) return candidate.getTime();
    }
    throw new Error("Could not calculate rule schedule.");
  }
  private resetTimer() {
    if (this.timer) clearInterval(this.timer);
    const now = this.now();
    this.nextRuns = Object.fromEntries(this.store.rules.map(rule => [rule.id, this.nextRun(rule, now)]));
    this.timer = setInterval(() => { void this.track(this.tickSchedules()).catch(() => {}); }, 1000);
    this.timer.unref();
  }
  async tickSchedules() {
    if (this.closed) return;
    const now = this.now();
    const due = this.store.rules.filter(rule => (this.nextRuns[rule.id] ?? Infinity) <= now);
    if (!due.length) return;
    for (const rule of due) this.nextRuns[rule.id] = this.nextRun(rule, now);
    this.emit();
    if (this.state.paused || !this.store.token) return;
    this.scanStatus = "scanning"; this.emit();
    try { await this.scanner.scan(due); this.scanStatus = "idle"; }
    catch { this.scanStatus = "Scan failed. Check connection and rules."; }
    finally { this.emit(); }
  }
  private async checkRules() { this.ensureOpen(); if (this.state.paused) throw new Error("Engine is paused."); this.scanStatus = "scanning"; this.emit(); try { await this.scanner.scan(this.store.rules); this.scanStatus = "idle"; } catch { this.scanStatus = "Scan failed. Check connection and rules."; throw new Error(this.scanStatus); } finally { this.emit(); } }
  execute(command: EngineCommand, args: unknown[] = [], requestId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Engine is closed."));
    if (!Array.isArray(args) || args.length > 3) return Promise.reject(new Error("Invalid command arguments."));
    if (command === "checkRules") return this.track(this.run(command, args, requestId));
    const operation = this.commands.catch(() => {}).then(() => this.run(command, args, requestId));
    this.commands = operation; return this.track(operation);
  }
  private async run(command: EngineCommand, args: unknown[], requestId?: string): Promise<unknown> {
    this.ensureOpen();
    const [a, b] = args;
    switch (command) {
      case "storageStatus": {
        if (args.length) throw new Error("Invalid command arguments.");
        const locations: { id: string; kind: "download" | "staging"; path: string }[] = this.roots.length
          ? this.roots.map(root => ({ id: root.id, kind: "download", path: root.path }))
          : this.store.settings.downloadDirectory ? [{ id: "local-download", kind: "download", path: this.store.settings.downloadDirectory }] : [];
        const staging = this.stagingRoot || this.store.settings.stagingDirectory;
        if (staging) locations.push({ id: "staging", kind: "staging", path: staging });
        return storageStatus(locations);
      }
      case "listFiles": return this.api.listFiles(id(a));
      case "moveFile": return this.api.moveFile(id(a), id(b));
      case "renameFile": return this.api.renameFile(id(a), name(b));
      case "createFolder": return this.api.createFolder(id(a), name(b));
      case "deleteFile": return this.api.deleteFile(id(a));
      case "listTransfers": return this.api.listTransfers();
      case "cancelTransfer": return this.api.cancelTransfer(id(a));
      case "addTransfer": if (typeof a !== "string" || a.length > 8192 || !/^magnet:\?/i.test(a)) throw new Error("Enter a magnet link."); return this.api.addTransfer(a, id(b));
      case "downloadFile": case "downloadZip": case "retryDownload": {
        if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId))) throw new Error("Invalid request ID.");
        if (requestId && !this.state.receipts[requestId] && Object.keys(this.state.receipts).length >= 10000) throw new Error("Request receipt limit reached.");
        const fingerprint = JSON.stringify([command, a, b]);
        if (requestId && this.state.receipts[requestId]) { const receipt = this.state.receipts[requestId]; if (receipt.fingerprint !== fingerprint) throw new Error("Request ID conflicts with an earlier command."); return { jobId: receipt.jobId }; }
        let d: Description;
        if (command === "retryDownload") {
          if (typeof a !== "string") throw new Error("Invalid job.");
          const old = this.queue.jobs.find(j => j.id === a);
          if (!old || !this.state.descriptions[a]) throw new Error("Job cannot be retried.");
          d = structuredClone(this.state.descriptions[a]);
          const jobId = a;
          const retry = this.enqueueWrites.catch(() => {}).then(async () => {
            this.ensureOpen();
            const root = await this.validateDirectory(d.root);
            if (d.staging && this.state.stagingProbe) throw new Error("A previous staging check requires inspection.");
            await this.validateStagingDescription(d, this.state.recovery?.[jobId]);
            this.queue.paused = true;
            try {
              await this.queue.reconcileSettledCloses();
              const record = this.state.recovery?.[jobId];
              if (record?.closeUncertainProcess !== undefined) throw new Error("Download file could not be safely closed.");
              const released = record?.delivery && (record.delivery.destinationAnchorRelease || record.delivery.retiredDestinations?.some(item => item.release) || (record.delivery.stageAnchorRelease && record.finalization?.phase !== "published"));
              if (released && (record?.finalization || (record?.intent !== "canceled" && old.error !== "Source changed; retry to accept the refreshed source."))) throw new Error("Released staging ownership cannot be resumed.");
              if (record?.delivery && record.finalization) {
                const published = await fs.lstat(old.destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
                if (published) {
                  await recoverPublished(old, root, record, (_role, handle, settlement) => this.queue.retainUncertain(jobId, handle, settlement), this.options.stagedCloseAdapter);
                  if (!["completed", "unverified"].includes(old.status)) { await this.persist(); throw new Error("Published destination could not be verified."); }
                  record.delivery.phase = "stage-cleanup-pending";
                  try { if (!record.delivery.stageAnchorRelease) await discardOwnedStage(record, (_role, handle, settlement) => this.queue.retainUncertain(jobId, handle, settlement), this.options.stagedCloseAdapter); old.stagingWarning = undefined; }
                  catch (error) { if (await this.queue.retainCloseError(jobId, error)) throw error; old.stagingWarning = "The verified output is safe, but its staged copy could not be removed."; }
                  if (requestId) this.state.receipts[requestId] = { fingerprint, jobId };
                  await this.persist();
                  if (!old.stagingWarning && !this.queue.hasUncertainOpen() && record.closeUncertainProcess === undefined && record.cleanup?.phase !== "in-flight" && ![...this.folderCandidates.values()].some(candidate => candidate.jobId === jobId)) await releaseStagedAnchors(old, record, () => this.persist(), (_role, handle, settlement) => this.queue.retainUncertain(jobId, handle, settlement), this.options.stagedCloseAdapter);
                  return;
                }
                if (record.finalization.phase !== "prepared") throw new Error("Published destination could not be verified.");
                delete record.finalization; record.delivery.phase = "copying"; await this.persist();
              }
              await this.queue.retry(jobId, this.source(d), this.cleanup(d, jobId), root, this.sourceIdentity(d));
              if (requestId) this.state.receipts[requestId] = { fingerprint, jobId };
              await this.persist();
            } catch (error) {
              await this.queue.retainCloseError(jobId, error);
              if (old.status === "queued") {
                old.status = "needs-attention"; old.error = "Could not save job state; download did not start.";
                await this.persist().catch(() => {}); this.emit();
              }
              throw error;
            } finally { this.queue.paused = this.closed || this.state.paused; if (!this.closed) this.queue.pump(); }
          });
          this.enqueueWrites = retry; await retry;
          return { jobId };
        } else {
          const file = await this.api.getFile(id(a), this.shutdownSignal.signal);
          this.ensureOpen();
          if (command === "downloadFile" && file.isFolder) throw new Error("Use ZIP download for folders.");
          if (command === "downloadZip") file.name += ".zip";
          const dir = await this.validateDirectory(this.store.settings.downloadDirectory);
          const options = this.validateOptions(b);
          d = { file, dir, root: dir, zip: command === "downloadZip", cleanup: options.deleteAfterDownload ?? this.store.settings.deleteAfterDownload, deleteSourceFolders: options.deleteSourceFolders ?? this.store.settings.deleteSourceFolders, folderCleanupKeep: options.deleteSourceFolders === false, folderCleanup: { ancestry: file.parentId && file.parentId !== "0" ? [file.parentId] : [], extensions: [], minSizeBytes: 0 }, speedLimitBytesPerSecond: options.speedLimitBytesPerSecond ?? this.store.settings.speedLimitBytesPerSecond };
        }
        const jobId = await this.enqueue(d, requestId ? { requestId, fingerprint } : undefined, true);
        return { jobId };
      }
      case "cancelDownloads": if (a !== undefined && (!Array.isArray(a) || a.some(v => typeof v !== "string"))) throw new Error("Invalid jobs."); await this.queue.cancel(a as string[] | undefined); await this.persist(); return;
      case "pause": this.state.paused = true; this.queue.paused = true; await this.queue.pause(); this.emit(); return;
      case "resume": this.state.paused = false; this.queue.resume(); try { await this.persist(); } catch (error) { this.state.paused = true; this.queue.paused = true; throw error; } this.resetTimer(); this.ensureOpen(); this.queue.pump(); this.emit(); return;
      case "checkRules": return this.checkRules();
      case "selectDownloadRoot": {
        const root = this.roots.find(r => r.id === a); if (!root || (b !== undefined && typeof b !== "string")) throw new Error("Invalid download root.");
        const rel = (b as string | undefined) ?? ""; if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(part => part === "..")) throw new Error("Invalid relative directory.");
        const dir = await this.validateDirectory(path.resolve(root.path, rel)); this.ensureOpen(); this.store.settings.downloadDirectory = dir; await this.store.save(); this.emit(); return this.snapshot();
      }
      case "saveSettings": return this.saveSettings(a);
      case "prepareRuleDirectory": return this.prepareRuleDirectory(a);
      case "addRule": return this.addRule(a);
      case "updateRule": return this.addRule(b, a);
      case "removeRule": if (typeof a !== "string") throw new Error("Invalid rule."); this.rulesGeneration++; this.store.rules = this.store.rules.filter(r => r.id !== a); await this.store.save(); delete this.nextRuns[a]; this.emit(); return;
      case "beginAccountLink": return this.beginLink();
      case "cancelAccountLink": this.linkGeneration++; this.linkAbort?.abort(); this.connection = this.connectionBeforeLink; this.emit(); return;
      default: throw new Error("Unknown command.");
    }
  }
  private async saveSettings(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings.");
    const next: Settings = { ...this.store.settings }; let token = this.store.token;
    for (const [key, value] of Object.entries(input)) {
      switch (key) {
        case "token": if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid token."); token = value.trim(); break;
        case "downloadDirectory": next.downloadDirectory = await this.validateDirectory(value); break;
        case "stagingDirectory": {
          if (value === "") { if (this.roots.length && this.stagingRoot) throw new Error("Staging directory must match the configured server directory."); next.stagingDirectory = ""; break; }
          if (this.roots.length) {
            if (!this.stagingRoot || typeof value !== "string" || !samePath(value, this.stagingRoot) || !samePath(await fs.realpath(value), this.stagingRoot)) throw new Error("Staging directory must match the configured server directory.");
            next.stagingDirectory = this.stagingRoot;
          } else next.stagingDirectory = await this.validateDirectory(value);
          if (process.platform === "win32" && next.stagingDirectory.startsWith("\\\\")) throw new Error("Staging must use engine-local storage.");
          break;
        }
        case "stageDownloads": if (typeof value !== "boolean") throw new Error("Invalid staging setting."); next.stageDownloads = value; break;
        case "stagingMaxBytes": if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid staging budget."); next.stagingMaxBytes = Number(value); break;
        case "stagingMinimumFreeBytes": if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid staging reserve."); next.stagingMinimumFreeBytes = Number(value); break;
        case "speedLimitBytesPerSecond": if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Speed limit must be zero or a positive whole number of bytes per second."); next.speedLimitBytesPerSecond = Number(value); break;
        case "parallelDownloads": if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) throw new Error("Concurrency must be between 1 and 20."); next.parallelDownloads = Number(value); break;
        case "autoDownloadInterval": if (!Number.isInteger(value) || Number(value) < 10 || Number(value) > 86400) throw new Error("Interval must be between 10 and 86400 seconds."); next.autoDownloadInterval = Number(value); break;
        case "deleteSourceFolders": case "deleteAfterDownload": case "showToolTips": case "autoStartApplication": if (typeof value !== "boolean") throw new Error("Invalid setting."); (next as any)[key] = value; break;
        default: throw new Error("Unknown setting.");
      }
    }
    if (next.stageDownloads && (!next.stagingDirectory || (this.roots.length > 0 && !this.stagingRoot))) throw new Error("Configure an engine-local staging directory before enabling staging.");
    if (next.stageDownloads) {
      const authorized = this.roots.length ? this.stagingRoot : await this.validateDirectory(next.stagingDirectory);
      if (!authorized || !samePath(next.stagingDirectory, authorized) || !samePath(await fs.realpath(next.stagingDirectory), authorized)) throw new Error("Staging directory is not authorized on this engine.");
      await ensureSafeDirectory(authorized, authorized, false);
      if (!this.store.settings.stageDownloads || !samePath(this.store.settings.stagingDirectory, authorized)) await this.verifyStagingWritable(authorized);
    }
    const tokenChanged = token !== this.store.token;
    if (token && tokenChanged) { this.connection = { status: "checking" }; this.emit(); try { await this.api.validateToken(token); } catch { this.connection = { status: "error", message: "Could not validate the account." }; this.emit(); throw new Error("Could not validate the account."); } }
    this.ensureOpen();
    const previousSettings = this.store.settings, previousToken = this.store.token;
    if (next.stageDownloads && !previousSettings.stageDownloads && this.state.stagingNotice) {
      const notice = this.state.stagingNotice; delete this.state.stagingNotice;
      try { await this.persist(); } catch (error) { this.state.stagingNotice = notice; throw error; }
    }
    this.store.settings = next; this.store.token = token;
    try { await this.store.save(); } catch { this.store.settings = previousSettings; this.store.token = previousToken; throw new Error("Could not save settings."); }
    this.ensureOpen(); if (tokenChanged) this.connection = { status: token ? "connected" : "disconnected" };
    if (next.autoDownloadInterval !== previousSettings.autoDownloadInterval) { const now = this.now(); for (const rule of this.store.rules) if (!rule.schedule) this.nextRuns[rule.id] = this.nextRun(rule, now); }
    this.queue.pump(); this.emit(); return this.snapshot();
  }
  private validateOptions(value: unknown): { deleteSourceFolders?: boolean; deleteAfterDownload?: boolean; speedLimitBytesPerSecond?: number } {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid download options.");
    const o = value as Record<string, unknown>;
    if (Object.keys(o).some(key => !["deleteSourceFolders", "deleteAfterDownload", "speedLimitBytesPerSecond"].includes(key)) ||
        (o.deleteAfterDownload !== undefined && typeof o.deleteAfterDownload !== "boolean") ||
        (o.deleteSourceFolders !== undefined && typeof o.deleteSourceFolders !== "boolean") ||
        (o.speedLimitBytesPerSecond !== undefined && (!Number.isSafeInteger(o.speedLimitBytesPerSecond) || Number(o.speedLimitBytesPerSecond) < 0))) throw new Error("Invalid download options.");
    return o as { deleteSourceFolders?: boolean; deleteAfterDownload?: boolean; speedLimitBytesPerSecond?: number };
  }
  private async prepareRuleDirectory(value: unknown) {
    if (typeof value !== "string" || !value || path.isAbsolute(value)) throw new Error("Enter a relative folder name.");
    const parts = value.split(/[\\/]/);
    if (parts.some(part => !part)) throw new Error("Enter a valid folder name.");
    for (const part of parts) safeName(part);
    const root = await this.validateDirectory(this.store.settings.downloadDirectory);
    const canonicalRoot = root;
    await ensureSafeDirectory(canonicalRoot, canonicalRoot);
    const dir = path.join(canonicalRoot, ...parts);
    await ensureSafeDirectory(canonicalRoot, dir);
    if (!this.roots.length) this.allowed.set(pathIdentity(dir), dir);
    return dir;
  }
  private async addRule(value: unknown, existingId?: unknown) {
    const r = value as Omit<AutoDownloadRule, "id">;
    if (!r || typeof r !== "object" || !Array.isArray(r.extensions) || r.extensions.some(e => typeof e !== "string" || !/^\.?[a-z0-9]+$/i.test(e)) || !Number.isSafeInteger(r.minSizeBytes) || r.minSizeBytes < 0 || typeof r.keepFolderStructure !== "boolean" || !validSchedule(r.schedule)) throw new Error("Invalid rule.");
    const options = this.validateOptions({ deleteSourceFolders: r.deleteSourceFolders, deleteAfterDownload: r.deleteAfterDownload, speedLimitBytesPerSecond: r.speedLimitBytesPerSecond });
    let index = -1;
    if (existingId !== undefined) { if (typeof existingId !== "string") throw new Error("Invalid rule."); index = this.store.rules.findIndex(rule => rule.id === existingId); if (index < 0) throw new Error("Rule not found."); }
    const rule: AutoDownloadRule = { id: index < 0 ? randomUUID() : existingId as string, folderId: id(r.folderId), folderName: name(r.folderName), downloadDirectory: await this.validateDirectory(r.downloadDirectory), extensions: [...r.extensions], minSizeBytes: r.minSizeBytes, keepFolderStructure: r.keepFolderStructure, ...options, ...(r.schedule ? { schedule: structuredClone(r.schedule) } : {}) };
    this.ensureOpen(); const previous = [...this.store.rules];
    this.rulesGeneration++;
    if (index < 0) this.store.rules.push(rule); else this.store.rules[index] = rule;
    try { await this.store.save(); } catch { this.store.rules = previous; throw new Error("Could not save rule."); }
    if (index < 0 || JSON.stringify(previous[index].schedule) !== JSON.stringify(rule.schedule)) this.nextRuns[rule.id] = this.nextRun(rule, this.now());
    this.emit();
  }
  private async beginLink(): Promise<{ url: string; expiresAt: string }> {
    if (this.connection.status === "connecting") throw new Error("A connection is already in progress.");
    const generation = ++this.linkGeneration; this.linkAbort = new AbortController(); this.connectionBeforeLink = { ...this.connection }; this.connection = { status: "connecting" }; this.emit();
    let resolveLink!: (value: { url: string; expiresAt: string }) => void;
    let rejectLink!: (error: Error) => void;
    const result = new Promise<{ url: string; expiresAt: string }>((resolve, reject) => { resolveLink = resolve; rejectLink = reject; });
    const linking = connectDevice(async url => { if (generation !== this.linkGeneration) throw new Error("Connection canceled."); resolveLink({ url, expiresAt: new Date(Date.now() + 120000).toISOString() }); }, undefined, this.options.transport, this.linkAbort.signal).then(async token => {
      if (generation !== this.linkGeneration || this.closed) return;
      await this.api.validateToken(token);
      if (generation !== this.linkGeneration || this.closed) return;
      const previous = this.store.token; this.store.token = token;
      try { await this.store.save(); } catch { this.store.token = previous; throw new Error("Could not save the account connection."); }
      this.connection = { status: "connected" }; this.emit();
    }).catch(() => { rejectLink(new Error("Could not connect the account.")); if (generation === this.linkGeneration && !this.closed) { this.connection = { status: "error", message: "Could not connect the account." }; this.emit(); } });
    this.track(linking);
    return result;
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.linkGeneration++; this.linkAbort?.abort(); this.shutdownSignal.abort();
    if (this.timer) clearInterval(this.timer); if (this.progressTimer) clearTimeout(this.progressTimer);
    this.queue.paused = true;
    const drain = (async () => {
      await Promise.allSettled([this.queue.stopActive(), ...this.pending]);
      await Promise.allSettled([this.enqueueWrites]);
      await this.queue.reconcileSettledCloses();
      await this.persist();
      if (this.queue.hasUncertainOpen()) throw new Error("A download file could not be safely closed; state ownership remains held.");
      await this.releaseLock?.(); this.releaseLock = undefined;
      this.listeners.clear();
    })();
    // If shutdown times out, retain ownership until the outstanding work and flush finish.
    const closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Engine shutdown timed out; state ownership remains held until work stops.")), 35000);
      drain.then(() => { clearTimeout(timer); if (this.closing === closing) this.closing = Promise.resolve(); resolve(); }, error => { clearTimeout(timer); if (this.closing === closing) this.closing = undefined; reject(error); });
    });
    this.closing = closing;
    return closing;
  }
}
export async function createEngine(options: EngineOptions): Promise<ApplicationEngine> { return ApplicationEngine.create(options); }
