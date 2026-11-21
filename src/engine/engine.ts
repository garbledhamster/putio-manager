import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PutioApi } from "../core/api";
import { connectDevice } from "../core/device-auth";
import { DownloadQueue, ensureSafeDirectory, pathIdentity, samePath } from "../core/downloads";
import { RuleScanner, safeName } from "../core/rules";
import { CredentialAdapter, SettingsStore, validSchedule } from "../core/settings";
import { AutoDownloadRule, DownloadJob, RemoteFile, Settings } from "../shared";
import { EngineClient, EngineCommand, EngineSnapshot } from "./contracts";
import { acquireStateLock } from "./state-lock";

export interface EngineOptions {
  stateDirectory: string;
  credentials: CredentialAdapter;
  label?: string;
  apiBase?: string;
  transport?: typeof fetch;
  roots?: { id: string; label: string; path: string }[];
  token?: string;
  now?: () => Date;
}
type FolderCleanup = { ancestry: string[]; ruleId?: string; ruleRoot?: string; extensions: string[]; minSizeBytes: number };
type Description = { file: RemoteFile; dir: string; root: string; zip: boolean; cleanup: boolean; deleteSourceFolders?: boolean; folderCleanupKeep?: boolean; folderCleanup?: FolderCleanup; speedLimitBytesPerSecond?: number };
type FolderCandidate = { jobId: string; folderId: string; description: Description };
type Receipt = { fingerprint: string; jobId: string };
type State = { version: 1; id: string; paused: boolean; jobs: DownloadJob[]; descriptions: Record<string, Description>; receipts: Record<string, Receipt> };
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
    this.api = new PutioApi(() => this.store.token, options.apiBase, options.transport);
    this.roots = options.roots ?? [];
    this.queue = new DownloadQueue(() => this.store.settings.parallelDownloads, () => { void this.queueChanged()?.catch(() => {}); }, options.transport, () => this.persist(), () => this.store.settings.speedLimitBytesPerSecond);
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
    await engine.store.load();
    if (options.token !== undefined) engine.store.token = options.token;
    try {
      const loaded = JSON.parse(await fs.readFile(path.join(options.stateDirectory, "engine.json"), "utf8"));
      if (loaded.version !== 1 || typeof loaded.id !== "string" || typeof loaded.paused !== "boolean" || !Array.isArray(loaded.jobs) || !loaded.descriptions || !loaded.receipts) throw new Error();
      engine.state = loaded;
    } catch (error: any) { if (error.code !== "ENOENT") throw new Error("Could not read engine state."); }
    if (!engine.roots.length) {
      for (const dir of [engine.store.settings.downloadDirectory, ...engine.store.rules.map(rule => rule.downloadDirectory)].filter(Boolean)) {
        const resolved = path.resolve(dir);
        const canonical = await fs.realpath(resolved).catch(() => resolved);
        engine.allowed.set(pathIdentity(resolved), canonical); engine.allowed.set(pathIdentity(canonical), canonical);
      }
    } else {
      for (const dir of [engine.store.settings.downloadDirectory, ...engine.store.rules.map(r => r.downloadDirectory)].filter(Boolean)) await engine.validateDirectory(dir);
    }
    engine.queue.paused = true;
    for (const job of engine.state.jobs) {
      if (!job || typeof job.id !== "string" || typeof job.fileId !== "string" || typeof job.destination !== "string" || typeof job.status !== "string") throw new Error("Invalid saved job.");
      const description = engine.state.descriptions[job.id];
      if (job.status === "cleaning") { job.status = "completed"; job.error = "Downloaded locally; remote cleanup outcome is unknown."; }
      if (["downloading", "finalizing"].includes(job.status)) { job.status = "interrupted"; job.error = "Interrupted by engine restart; retry explicitly."; job.speed = 0; }
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
      if (job.status === "queued" && !valid) { job.status = "interrupted"; job.error = "Saved job destination is no longer allowed."; }
      if (valid) engine.queue.restore(job, description.root, engine.source(description), engine.cleanup(description, job.id));
      else engine.queue.jobs.push(job);
    }
    await engine.persist();
    engine.queue.paused = engine.state.paused;
    engine.queue.pump();
    engine.resetTimer();
    if (engine.store.token) {
      engine.connection = { status: "checking" };
      void engine.api.validateToken(engine.store.token).then(() => { if (!engine.closed) { engine.connection = { status: "connected" }; engine.emit(); } }, () => { if (!engine.closed) { engine.connection = { status: "error", message: "Could not validate the saved account." }; engine.emit(); } });
    }
    return engine;
    } catch (error) { await engine.releaseLock?.(); throw error; }
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
  private source(d: Description) { return (signal: AbortSignal) => d.zip ? this.api.zipUrl(d.file.id, 120, 1000, signal) : this.api.downloadUrl(d.file.id, signal); }
  private cleanup(d: Description, jobId: string) {
    if (!d.cleanup) return undefined;
    return async () => {
      this.ensureOpen(); await this.api.deleteFile(d.file.id); this.ensureOpen();
      if (d.deleteSourceFolders && !d.file.isFolder && !d.zip && d.folderCleanup) {
        for (const folderId of [...d.folderCleanup.ancestry].reverse()) {
          if (folderId !== "0" && folderId !== d.folderCleanup.ruleRoot) this.folderCandidates.set(`${jobId}:${folderId}`, { jobId, folderId, description: d });
        }
      }
    };
  }
  private enqueue(d: Description, receipt?: { requestId: string; fingerprint: string }): Promise<string> {
    const operation = this.enqueueWrites.catch(() => {}).then(async () => {
      this.ensureOpen();
      const originalRoot = d.root;
      const relative = path.relative(originalRoot, d.dir);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Download directory is outside its selected root.");
      d.root = await this.validateDirectory(originalRoot);
      d.dir = path.join(d.root, relative);
      this.ensureOpen();
      this.queue.paused = true;
      this.accepting = true;
      const proposed = randomUUID();
      this.state.descriptions[proposed] = d;
      try {
        const jobId = await this.queue.enqueue(d.file, d.dir, this.source(d), this.cleanup(d, proposed), d.root, proposed, { deleteAfterDownload: d.cleanup, deleteSourceFolders: d.deleteSourceFolders ?? false, speedLimitBytesPerSecond: d.speedLimitBytesPerSecond ?? 0 }, d.root);
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
  private scheduleFolderCleanup() {
    if (this.closed || !this.folderCandidates.size) return;
    if (this.folderDrain) { this.folderDrainRequested = true; return; }
    const work = (async () => {
      try { await this.scanner.whenIdle(); }
      catch { this.folderCandidates.clear(); return; }
      for (const [key, candidate] of this.folderCandidates) {
        if (this.closed) return;
        const job = this.queue.jobs.find(item => item.id === candidate.jobId);
        if (!job || job.status !== "completed" || job.error) continue;
        const details = candidate.description.folderCleanup!;
        if (!this.ruleStillMatches(details) || (details.ruleId && this.scanStatus !== "idle")) { this.folderCandidates.delete(key); continue; }
        try {
          const generation = this.rulesGeneration;
          const protectedRoots = new Set(this.store.rules.map(rule => rule.folderId));
          if (candidate.folderId === "0" || protectedRoots.has(candidate.folderId)) { this.folderCandidates.delete(key); continue; }
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
          this.folderCandidates.delete(key);
          if (eligible || protectedFolder || this.closed || this.state.paused || this.scanStatus === "scanning" || this.rulesGeneration !== generation || !this.ruleStillMatches(details) || this.store.rules.some(rule => folders.has(rule.folderId))) continue;
          // The provider exposes no conditional delete; a remote addition after this scan can race this request.
          await this.api.deleteFile(candidate.folderId);
          for (const [otherKey, other] of this.folderCandidates) if (folders.has(other.folderId)) this.folderCandidates.delete(otherKey);
        } catch {
          this.folderCandidates.delete(key);
          if (!this.closed) { job.error = "Downloaded locally; source folder cleanup failed."; await this.persist(); this.emit(); }
        }
      }
    })();
    this.folderDrain = work;
    this.track(work);
    void work.finally(() => { if (this.folderDrain === work) this.folderDrain = undefined; if (this.folderDrainRequested) { this.folderDrainRequested = false; this.scheduleFolderCleanup(); } }).catch(() => {});
  }
  private emit() { this.revision++; const snapshot = this.snapshot(); for (const listener of this.listeners) { try { listener(structuredClone(snapshot)); } catch { /* subscriber is isolated */ } } }
  private snapshot(): EngineSnapshot { return { settings: { ...this.store.settings }, hasToken: !!this.store.token, secureStorageAvailable: this.options.credentials.available(), rules: structuredClone(this.store.rules), jobs: structuredClone(this.queue.jobs), scanStatus: this.scanStatus, engine: { id: this.state.id, label: this.options.label ?? "Local", protocolVersion: 2, epoch: this.epoch, revision: this.revision }, connection: { ...this.connection }, paused: this.state.paused, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, nextRuleRuns: Object.fromEntries(Object.entries(this.nextRuns).map(([key, value]) => [key, new Date(value).toISOString()])), roots: this.roots.map(({ id, label }) => ({ id, label })) }; }
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
      case "listFiles": return this.api.listFiles(id(a));
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
          if (!old || !["failed", "canceled", "interrupted"].includes(old.status) || !this.state.descriptions[a]) throw new Error("Job cannot be retried.");
          d = structuredClone(this.state.descriptions[a]);
        } else {
          const file = await this.api.getFile(id(a), this.shutdownSignal.signal);
          this.ensureOpen();
          if (command === "downloadFile" && file.isFolder) throw new Error("Use ZIP download for folders.");
          if (command === "downloadZip") file.name += ".zip";
          const dir = await this.validateDirectory(this.store.settings.downloadDirectory);
          const options = this.validateOptions(b);
          d = { file, dir, root: dir, zip: command === "downloadZip", cleanup: options.deleteAfterDownload ?? this.store.settings.deleteAfterDownload, deleteSourceFolders: options.deleteSourceFolders ?? this.store.settings.deleteSourceFolders, folderCleanupKeep: options.deleteSourceFolders === false, folderCleanup: { ancestry: file.parentId && file.parentId !== "0" ? [file.parentId] : [], extensions: [], minSizeBytes: 0 }, speedLimitBytesPerSecond: options.speedLimitBytesPerSecond ?? this.store.settings.speedLimitBytesPerSecond };
        }
        const jobId = await this.enqueue(d, requestId ? { requestId, fingerprint } : undefined);
        return { jobId };
      }
      case "cancelDownloads": if (a !== undefined && (!Array.isArray(a) || a.some(v => typeof v !== "string"))) throw new Error("Invalid jobs."); this.queue.cancel(a as string[] | undefined); await this.persist(); return;
      case "pause": this.state.paused = true; this.queue.paused = true; await this.persist(); this.emit(); return;
      case "resume": this.state.paused = false; this.resetTimer(); await this.persist(); this.ensureOpen(); this.queue.paused = false; this.queue.pump(); this.emit(); return;
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
        case "speedLimitBytesPerSecond": if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Speed limit must be zero or a positive whole number of bytes per second."); next.speedLimitBytesPerSecond = Number(value); break;
        case "parallelDownloads": if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) throw new Error("Concurrency must be between 1 and 20."); next.parallelDownloads = Number(value); break;
        case "autoDownloadInterval": if (!Number.isInteger(value) || Number(value) < 10 || Number(value) > 86400) throw new Error("Interval must be between 10 and 86400 seconds."); next.autoDownloadInterval = Number(value); break;
        case "deleteSourceFolders": case "deleteAfterDownload": case "showToolTips": case "autoStartApplication": if (typeof value !== "boolean") throw new Error("Invalid setting."); (next as any)[key] = value; break;
        default: throw new Error("Unknown setting.");
      }
    }
    const tokenChanged = token !== this.store.token;
    if (token && tokenChanged) { this.connection = { status: "checking" }; this.emit(); try { await this.api.validateToken(token); } catch { this.connection = { status: "error", message: "Could not validate the account." }; this.emit(); throw new Error("Could not validate the account."); } }
    this.ensureOpen();
    const previousSettings = this.store.settings, previousToken = this.store.token;
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
      await this.persist();
      await this.releaseLock?.(); this.releaseLock = undefined;
      this.listeners.clear();
    })();
    // If shutdown times out, retain ownership until the outstanding work and flush finish.
    this.closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Engine shutdown timed out; state ownership remains held until work stops.")), 35000);
      drain.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    return this.closing;
  }
}
export async function createEngine(options: EngineOptions): Promise<ApplicationEngine> { return ApplicationEngine.create(options); }
