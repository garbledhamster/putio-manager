import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DownloadJob, RemoteFile } from "../shared";
import { safeName } from "./rules";
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
  paused = false;
  private active = new Map<string, AbortController>();
  private sources = new Map<string, (signal: AbortSignal) => Promise<string>>();
  private cleanup = new Map<string, () => Promise<void>>();
  private roots = new Map<string, string>();
  private aggregateNext = 0;
  private aggregateRate = 0;
  constructor(
    private concurrency: () => number,
    private changed: () => void,
    private transport: typeof fetch = fetch,
    private flush: () => Promise<void> = async () => {},
    private globalRate: () => number = () => 0,
  ) {}
  async enqueue(
    file: RemoteFile,
    dir: string,
    source: (signal: AbortSignal) => Promise<string>,
    cleanup?: () => Promise<void>,
    rootDirectory: string = dir,
    jobId?: string,
    options: { deleteAfterDownload?: boolean; deleteSourceFolders?: boolean; speedLimitBytesPerSecond?: number } = {},
    trustedCanonicalRoot?: string,
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
    const destination = path.join(canonicalRoot, relative, safeName(file.name));
    const existingJob = this.jobs.find(
      (j) => j.fileId === file.id && j.destination === destination &&
        !["failed", "canceled", "interrupted"].includes(j.status),
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
      speed: 0,
      addedAt: new Date().toISOString(),
      ...options,
    };
    this.jobs.push(job);
    this.sources.set(job.id, source);
    this.roots.set(job.id, canonicalRoot);
    if (cleanup) this.cleanup.set(job.id, cleanup);
    this.changed();
    this.pump();
    return job.id;
  }
  restore(job: DownloadJob, root: string, source: (signal: AbortSignal) => Promise<string>, cleanup?: () => Promise<void>) {
    this.jobs.push(job);
    if (job.status === "queued") {
      this.roots.set(job.id, root);
      this.sources.set(job.id, source);
      if (cleanup) this.cleanup.set(job.id, cleanup);
    }
  }
  cancel(ids?: string[]) {
    let changed = false;
    for (const job of this.jobs) {
      if (ids && !ids.includes(job.id)) continue;
      if (job.status === "queued") {
        job.status = "canceled";
        this.sources.delete(job.id);
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
    if (changed) this.changed();
  }
  async stopActive() {
    this.paused = true;
    this.cancel(this.jobs.filter(j => j.status === "downloading").map(j => j.id));
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 10));
  }
  pump() {
    while (!this.paused && this.active.size < Math.max(1, this.concurrency())) {
      const job = this.jobs.find((j) => j.status === "queued");
      if (!job) break;
      const controller = new AbortController();
      this.active.set(job.id, controller);
      job.status = "downloading";
      this.changed();
      void this.flush().then(() => this.run(job, controller), () => {
        job.status = "failed";
        job.error = "Could not save job state; download did not start.";
      }).finally(() => {
        this.active.delete(job.id);
        this.sources.delete(job.id);
        this.roots.delete(job.id);
        this.cleanup.delete(job.id);
        this.changed();
        this.pump();
      });
    }
  }
  private async run(job: DownloadJob, controller: AbortController) {
    const root = this.roots.get(job.id)!;
    const directory = path.dirname(job.destination);
    let tempCreated = false;
    const temp = path.join(
      directory,
      `.putio-${randomUUID()}.download`,
    );
    try {
      await ensureSafeDirectory(
        root,
        directory,
      );
      try {
        const existing = await fs.lstat(job.destination);
        if (!existing.isFile() || existing.isSymbolicLink())
          throw new Error("Unsafe existing destination.");
        job.status = "skipped";
        job.error =
          "Destination already exists; its contents were not verified.";
        return;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      const source = this.sources.get(job.id)!;
      const signal = controller.signal;
      signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      const canceled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Canceled"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let url: string;
      try {
        url = await Promise.race([source(signal), canceled]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      if (controller.signal.aborted) throw new Error("Canceled");
      const response = await this.transport(url, { signal: controller.signal });
      if (!response.ok || !response.body)
        throw new Error(`Download failed (${response.status}).`);
      const started = Date.now();
      let jobNext = 0;
      const progress = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          let offset = 0;
          const pace = () => {
            if (controller.signal.aborted) return done(new Error("Canceled"));
            if (offset >= chunk.length) return done();
            const now = Date.now();
            const rate = this.globalRate();
            if (rate !== this.aggregateRate) { this.aggregateRate = rate; this.aggregateNext = now; }
            const jobRate = job.speedLimitBytesPerSecond ?? 0;
            // Small slices bound wait time and let competing jobs reserve bandwidth fairly.
            const sliceSize = !rate && !jobRate ? chunk.length - offset : Math.max(1, Math.min(16384, rate > 0 ? Math.max(1, Math.floor(rate / 10)) : 16384, jobRate > 0 ? Math.max(1, Math.floor(jobRate / 10)) : 16384, chunk.length - offset));
            if (rate > 0) this.aggregateNext = Math.max(now, this.aggregateNext) + sliceSize * 1000 / rate;
            if (jobRate > 0) jobNext = Math.max(now, jobNext) + sliceSize * 1000 / jobRate;
            const delay = Math.max(0, this.aggregateNext - now, jobNext - now);
            const finish = () => {
              const part = chunk.subarray(offset, offset + sliceSize); offset += sliceSize;
              job.bytesReceived += sliceSize;
              job.speed = job.bytesReceived / Math.max(1, (Date.now() - started) / 1000);
              this.changed();
              progress.push(part);
              pace();
            };
            if (!delay) return finish();
            const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); finish(); }, delay);
            const abort = () => { clearTimeout(timer); done(new Error("Canceled")); };
            controller.signal.addEventListener("abort", abort, { once: true });
          };
          pace();
        },
      });
      await ensureSafeDirectory(root, directory, false);
      const output = createWriteStream(temp, { flags: "wx" });
      output.once("open", () => { tempCreated = true; });
      await pipeline(
        Readable.fromWeb(response.body as any),
        progress,
        output,
        { signal: controller.signal },
      );
      controller.signal.throwIfAborted();
      job.status = "finalizing";
      this.changed();
      await ensureSafeDirectory(root, directory, false);
      await fs.link(temp, job.destination);
      await ensureSafeDirectory(root, directory, false);
      await fs.unlink(temp);
      tempCreated = false;
      job.completedAt = new Date().toISOString();
      if (this.cleanup.has(job.id)) {
        job.status = "cleaning";
        this.changed();
        await this.flush();
        try {
          await this.cleanup.get(job.id)!();
        } catch {
          job.error = "Downloaded locally; remote cleanup failed.";
        }
      }
      job.status = "completed";
    } catch (error: any) {
      job.status = controller.signal.aborted ? "canceled" : "failed";
      job.error = controller.signal.aborted
        ? undefined
        : error.code === "EEXIST"
          ? "Destination already exists."
          : "Download failed.";
      if (tempCreated) {
        try { await ensureSafeDirectory(root, directory, false); await fs.rm(temp, { force: true }); } catch { /* A replaced root must never be used for cleanup. */ }
      }
    }
  }
}
