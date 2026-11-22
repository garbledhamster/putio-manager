import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, realpathSync, promises as fs } from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { pipeline } from "node:stream/promises";
import { downloadUpdateAsset, privateUpdateDirectory, verifyUpdateFile } from "./update-transfer";
import { updateErrorCode } from "./update-errors";
import type { UpdateFetch } from "./update-release";
import { compareVersions, stableVersion, validArchiveSignature } from "./update-release";
import type { DesktopUpdateAdapter, DesktopUpdateError, NativeUpdateContext, PreparedDesktopUpdate, VerifiedDesktopRelease } from "./update-types";

interface NativeDependencies {
  environment?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  handoffTimeoutMs?: number;
  fetcher?: UpdateFetch;
  rename?: typeof fs.rename;
  syncDirectory?: (directory: string) => Promise<void>;
}
const failure = (code: string) => new Error(code);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function versionIsNewer(next: string, current: string) {
  const a = next.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
type FileIdentity = Awaited<ReturnType<typeof imageIdentity>>;
async function imageIdentity(filename: string) {
  const info = await fs.lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw failure("unsupported-installation");
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, mode: Number(info.mode & 0o777n) };
}
function sameImage(first: FileIdentity, second: FileIdentity) { return first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs; }

/** Inherited AppImage variables identify this installation only when its running files belong to that mount. */
function linuxInstallation(context: NativeUpdateContext, environment: NodeJS.ProcessEnv) {
  try {
    const image = environment.APPIMAGE, mount = environment.APPDIR;
    if (!image || !mount || !path.isAbsolute(image) || !path.isAbsolute(mount) || !image.endsWith(".AppImage")) return;
    const filenames = [mount, context.applicationDirectory, context.resourcesDirectory, context.executablePath, image];
    const entries = filenames.map((filename, index) => {
      if (!path.isAbsolute(filename)) throw failure("unsupported-installation");
      const info = lstatSync(filename, { bigint: true }), canonical = realpathSync(filename);
      if (info.isSymbolicLink() || (index < 3 ? !info.isDirectory() : !info.isFile())) throw failure("unsupported-installation");
      return { filename, canonical, dev: info.dev, ino: info.ino };
    });
    // The runtime documents resolved APPIMAGE and a real APPDIR mountpoint.
    if (entries[0].canonical !== path.resolve(mount) || entries[4].canonical !== path.resolve(image)) return;
    for (const entry of entries.slice(1, 4)) {
      const relative = path.relative(entries[0].canonical, entry.canonical);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return;
    }
    return { image, mount, entries };
  } catch { return; }
}
function sameLinuxInstallation(context: NativeUpdateContext, environment: NodeJS.ProcessEnv, original: ReturnType<typeof linuxInstallation>) {
  const actual = linuxInstallation(context, environment);
  return !!original && !!actual && original.image === actual.image && original.mount === actual.mount && original.entries.every((entry, index) => {
    const current = actual.entries[index];
    return entry.filename === current.filename && entry.canonical === current.canonical && entry.dev === current.dev && entry.ino === current.ino;
  });
}
type NativeDirectoryOwner = { directory: string; canonical: string; dev: bigint; ino: bigint; root: string; rootDev: bigint; rootIno: bigint };
async function ownNativeDirectory(directory: string): Promise<NativeDirectoryOwner> {
  const info = await fs.lstat(directory, { bigint: true }), root = path.dirname(directory), parent = await fs.lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) throw failure("permission-required");
  return { directory, canonical: await fs.realpath(directory), dev: info.dev, ino: info.ino, root, rootDev: parent.dev, rootIno: parent.ino };
}
async function stillOwnNativeDirectory(owner: NativeDirectoryOwner): Promise<boolean> {
  try {
    const info = await fs.lstat(owner.directory, { bigint: true }), parent = await fs.lstat(owner.root, { bigint: true });
    return info.isDirectory() && !info.isSymbolicLink() && info.dev === owner.dev && info.ino === owner.ino && parent.isDirectory() && !parent.isSymbolicLink() && parent.dev === owner.rootDev && parent.ino === owner.rootIno && await fs.realpath(owner.directory) === owner.canonical;
  } catch { return false; }
}
/** Never recurse through a cache pathname: only an unchanged owned file is removable. */
async function removeNativePayload(owner: NativeDirectoryOwner, file?: FileIdentity, removeEmptyDirectory = true): Promise<void> {
  if (!await stillOwnNativeDirectory(owner)) return;
  if (file) {
    const filename = path.join(owner.directory, "verified-update.msi");
    try {
      const actual = await imageIdentity(filename);
      if (sameImage(file, actual) && await stillOwnNativeDirectory(owner)) await fs.unlink(filename);
    } catch {}
  }
  // Receipt/unknown files deliberately keep their directory alive.
  if (removeEmptyDirectory && await stillOwnNativeDirectory(owner)) await fs.rmdir(owner.directory).catch(() => {});
}
async function syncDirectory(directory: string) { const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); try { await handle.sync(); } finally { await handle.close(); } }
// Positional arguments are a verified PID and this installation's verified path.
// Never kill a PID: timeout exits if a reused PID or stalled parent remains alive.
const linuxRelaunchWaiter = 'printf "ready\\n"; exec >/dev/null 2>&1; n=0; while kill -0 "$1" 2>/dev/null; do n=$((n+1)); [ "$n" -ge 300 ] && exit 1; /bin/sleep 0.1; done; exec "$2" --enable-sandbox';

const nativeErrors = new Set<DesktopUpdateError>(["release-invalid", "signature-invalid", "download-invalid", "network", "storage-unavailable", "permission-required", "installer-cancelled", "installer-failed", "restart-required"]);
function nativeError(error: unknown): DesktopUpdateError { const code = updateErrorCode(error); return nativeErrors.has(code) ? code : "installer-failed"; }
async function writeNativeOperation(context: NativeUpdateContext, directory: string, version: string, phase: string, errorCode?: DesktopUpdateError) {
  const root = path.dirname(directory), info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o022))) throw failure("permission-required");
  const temporary = path.join(root, `native-${randomUUID()}.tmp`), target = path.join(root, "native-operation.json");
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(JSON.stringify({ schema: 1, version, fromVersion: context.currentVersion, directory: path.basename(directory), phase, ...(errorCode ? { errorCode } : {}) })); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, target);
}
async function privateRecord(filename: string): Promise<Record<string, unknown>> {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw failure("download-invalid");
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(), bytes = Buffer.alloc(4097), result = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || result.bytesRead > 4096) throw failure("download-invalid");
    const value = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("download-invalid");
    return value;
  } finally { await handle.close(); }
}
/** Receipts are hints; the actual running version is the installation witness. */
export async function readNativeUpdateOutcome(userDataDirectory: string, currentVersion: string): Promise<{ phase: "updated" | "failed" | "restart-required"; errorCode?: DesktopUpdateError } | undefined> {
  if (!path.isAbsolute(userDataDirectory) || !stableVersion(currentVersion)) return;
  try {
    const root = path.join(await fs.realpath(userDataDirectory), "desktop-updates"), info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== root || (process.platform !== "win32" && (info.mode & 0o022))) return;
    const operation = await privateRecord(path.join(root, "native-operation.json"));
    if (operation.schema !== 1 || !stableVersion(operation.version) || !stableVersion(operation.fromVersion) || typeof operation.directory !== "string" || !/^(mac|linux)-[A-Za-z0-9]{6}$/.test(operation.directory) || !["preparing", "ready", "installing", "installed", "failed"].includes(String(operation.phase)) || compareVersions(currentVersion, operation.version) > 0) return;
    if (currentVersion === operation.version) return { phase: "updated" };
    if (!["preparing", "ready"].includes(String(operation.phase))) {
      try {
        const directory = path.join(root, operation.directory), directoryInfo = await fs.lstat(directory);
        if (directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink() && await fs.realpath(directory) === directory && (process.platform === "win32" || (directoryInfo.mode & 0o022) === 0)) {
          const receipt = await privateRecord(path.join(directory, "receipt.json"));
          if (receipt.schema === 1 && receipt.phase === "failed" && nativeErrors.has(receipt.code as DesktopUpdateError)) {
            return receipt.code === "restart-required" ? { phase: "restart-required", errorCode: "restart-required" } : { phase: "failed", errorCode: receipt.code as DesktopUpdateError };
          }
        }
      } catch { /* A missing/unfinished receipt cannot override the root operation. */ }
    }
    if (operation.phase === "failed") {
      if (operation.errorCode === "restart-required") return currentVersion === operation.version ? { phase: "updated" } : { phase: "restart-required", errorCode: "restart-required" };
      return { phase: "failed", errorCode: nativeErrors.has(operation.errorCode as DesktopUpdateError) ? operation.errorCode as DesktopUpdateError : "installer-failed" };
    }
    if (["installing", "installed"].includes(String(operation.phase)) && currentVersion === operation.version) return { phase: "updated" };
    if (["preparing", "ready"].includes(String(operation.phase))) return { phase: "failed", errorCode: "installer-cancelled" };
    return { phase: "restart-required", errorCode: "restart-required" };
  } catch { return; }
}

type MacStage = { file: string; identity: FileIdentity; directory: string; owner: NativeDirectoryOwner; release: VerifiedDesktopRelease };
async function macFeed(stage: MacStage, onFailure: () => void): Promise<{ feedURL: string; archiveURL: string; close(): void }> {
  const nonce = randomUUID(), feedPath = `/${nonce}/appcast.xml`, archivePath = `/${nonce}/update.zip`;
  let authority = "", requests = 0, served = 0, closed = false;
  const close = () => { if (!closed) server.close(); closed = true; server.closeAllConnections(); };
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (closed || request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== authority || !["GET", "HEAD"].includes(request.method ?? "") || ![feedPath, archivePath].includes(request.url ?? "")) { response.writeHead(404); response.end(); return; }
      if (++requests > 32) throw failure("download-invalid");
      response.setHeader("Cache-Control", "no-store"); response.setHeader("Connection", "close");
      if (request.url === feedPath) {
        if (request.headers.range) { response.writeHead(416); response.end(); return; }
        const asset = stage.release.asset;
        const body = Buffer.from(`<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Putio Manager update</title><item><sparkle:version>${stage.release.version}</sparkle:version><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="http://${authority}${archivePath}" length="${asset.bytes}" type="application/octet-stream" sparkle:edSignature="${asset.ed25519}"/></item></channel></rss>`);
        response.writeHead(200, { "Content-Type": "application/xml", "Content-Length": body.length }); response.end(request.method === "HEAD" ? undefined : body); return;
      }
      if (!await stillOwnNativeDirectory(stage.owner) || !sameImage(stage.identity, await imageIdentity(stage.file))) throw failure("download-invalid");
      const handle = await fs.open(stage.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await handle.stat({ bigint: true });
        if (actual.dev !== stage.identity.dev || actual.ino !== stage.identity.ino || actual.size !== stage.identity.size || actual.mtimeNs !== stage.identity.mtimeNs || actual.ctimeNs !== stage.identity.ctimeNs) throw failure("download-invalid");
        const size = stage.release.asset.bytes; let start = 0, end = size - 1;
        if (request.headers.range) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
          if (!range || !Number.isSafeInteger(Number(range[1])) || (range[2] && !Number.isSafeInteger(Number(range[2])))) { response.writeHead(416); response.end(); return; }
          start = Number(range[1]); end = range[2] ? Number(range[2]) : end;
          if (start > end || end >= size) { response.writeHead(416); response.end(); return; }
          response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        const length = end - start + 1;
        if (request.method !== "HEAD" && served + length > size * 2) throw failure("download-invalid");
        response.writeHead(request.headers.range ? 206 : 200, { "Content-Type": "application/octet-stream", "Content-Length": length, "Accept-Ranges": "bytes" });
        if (request.method === "HEAD") { response.end(); return; }
        served += length;
        await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
        if (start === 0 && end === size - 1) {
          server.close(); closed = true;
          // Sparkle now owns its local copy. Retain recovery records, not a second
          // heavy archive, even when it terminates this host before handoff returns.
          await removeNativePayload(stage.owner, stage.identity, false);
        }
      } finally { await handle.close(); }
    })().catch(() => { response.destroy(); close(); onFailure(); });
  });
  server.maxHeadersCount = 16; server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 1;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", () => { close(); onFailure(); });
  await new Promise<void>((resolve, reject) => { server.once("error", () => reject(failure("installer-failed"))); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw failure("installer-failed"); }
  authority = `127.0.0.1:${address.port}`;
  return { feedURL: `http://${authority}${feedPath}`, archiveURL: `http://${authority}${archivePath}`, close };
}

function createMacUpdateAdapter(context: NativeUpdateContext, dependencies: NativeDependencies, helperPath: string): DesktopUpdateAdapter {
  let stage: MacStage | undefined, prepared: PreparedDesktopUpdate | undefined, busy = false, transferred = false;
  let generation = 0;
  let abortPreparation: AbortController | undefined;
  async function discard() { if (stage) { const owned = stage; stage = undefined; await removeNativePayload(owned.owner, owned.identity); } prepared = undefined; }
  return {
    supported: context.isPackaged && ["x64", "arm64"].includes(context.arch) && existsSync(helperPath),
    async prepare(input, signal, progress) {
      if (!this.supported) throw failure("unsupported-installation");
      if (busy || prepared || transferred) throw failure("installer-busy");
      const release: VerifiedDesktopRelease = { ...input, asset: { ...input.asset }, assets: [] };
      const expected = `PutioManager-${release.version}-macos-${context.arch}-update.zip`;
      if (!stableVersion(release.version) || !stableVersion(context.currentVersion) || compareVersions(release.version, context.currentVersion) <= 0 || release.platform !== "macos" || release.arch !== context.arch || release.asset.name !== expected || release.asset.url !== `https://github.com/garbledhamster/putio-manager/releases/download/v${release.version}/${expected}` || !validArchiveSignature(release.asset.ed25519)) throw failure("release-invalid");
      if (signal.aborted) throw failure("installer-cancelled");
      busy = true; const operation = ++generation; abortPreparation = new AbortController(); const abort = () => abortPreparation?.abort(); signal.addEventListener("abort", abort, { once: true });
      let directory: string | undefined, owner: NativeDirectoryOwner | undefined, downloadedIdentity: FileIdentity | undefined;
      try {
        await discard();
        directory = await privateUpdateDirectory(context.userDataDirectory, "mac-");
        owner = await ownNativeDirectory(directory);
        await writeNativeOperation(context, directory, release.version, "preparing");
        const file = await downloadUpdateAsset(release.asset, directory, abortPreparation.signal, percent => progress({ phase: "downloading", percent }), dependencies.fetcher);
        if (!await stillOwnNativeDirectory(owner)) throw failure("download-invalid");
        downloadedIdentity = await imageIdentity(file);
        if (!await stillOwnNativeDirectory(owner)) throw failure("download-invalid");
        progress({ phase: "verifying" }); await verifyUpdateFile(file, release.asset, abortPreparation.signal);
        if (signal.aborted || abortPreparation.signal.aborted) throw failure("installer-cancelled");
        const identity = await imageIdentity(file);
        if (signal.aborted || abortPreparation.signal.aborted || operation !== generation) throw failure("installer-cancelled");
        stage = { file, identity, directory, owner, release };
        prepared = { version: release.version, id: randomUUID() };
        await writeNativeOperation(context, directory, release.version, "ready");
        if (signal.aborted || abortPreparation.signal.aborted || operation !== generation) throw failure("installer-cancelled");
        progress({ phase: "ready" }); return { ...prepared };
      } catch (error) {
        const code = signal.aborted || abortPreparation.signal.aborted ? "installer-cancelled" : nativeError(error);
        if (directory) await writeNativeOperation(context, directory, release.version, "failed", code).catch(() => {});
        if (owner) await removeNativePayload(owner, downloadedIdentity);
        stage = undefined; prepared = undefined; throw failure(code);
      } finally { busy = false; signal.removeEventListener("abort", abort); abortPreparation = undefined; }
    },
    async handoff(value) {
      if (!stage || !prepared || value.id !== prepared.id || value.version !== prepared.version || busy || transferred) throw failure("installer-failed");
      busy = true; const operation = generation, selected = stage; prepared = undefined; let listener: Awaited<ReturnType<typeof macFeed>> | undefined, child: ChildProcess | undefined;
      let terminal: DesktopUpdateError | undefined, rejectRunning: ((error: Error) => void) | undefined;
      try {
        if (!await stillOwnNativeDirectory(selected.owner)) throw failure("download-invalid");
        await verifyUpdateFile(selected.file, selected.release.asset);
        if (!sameImage(selected.identity, await imageIdentity(selected.file))) throw failure("download-invalid");
        await writeNativeOperation(context, selected.directory, value.version, "installing");
        listener = await macFeed(selected, () => { terminal = "download-invalid"; rejectRunning?.(failure(terminal)); child?.kill(); });
        if (operation !== generation) throw failure("installer-cancelled");
        const transfer = listener;
        await new Promise<void>((resolve, reject) => {
          let settled = false, buffer = "", available = false, finished = false;
          const complete = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); rejectRunning = undefined; error ? reject(error) : resolve(); };
          rejectRunning = error => complete(error);
          const timer = setTimeout(() => { terminal = "restart-required"; complete(failure(terminal)); }, Math.max(1, Math.min(600000, dependencies.handoffTimeoutMs ?? 120000)));
          try { child = (dependencies.spawn ?? spawn)(helperPath, [context.applicationDirectory, "--check-immediately", "--user-agent-name", "PutioManager", "--feed-url", transfer.feedURL], { shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...(dependencies.environment ?? process.env), PUTIO_UPDATER_AUTHORIZED: "1", PUTIO_UPDATER_EXPECTED_VERSION: value.version, PUTIO_UPDATER_EXPECTED_URL: transfer.archiveURL, PUTIO_UPDATER_EXPECTED_SIGNATURE: selected.release.asset.ed25519!, PUTIO_UPDATER_EXPECTED_BYTES: String(selected.release.asset.bytes), PUTIO_UPDATER_RECEIPT: path.join(selected.directory, "receipt.json") } }); }
          catch { complete(failure("installer-failed")); return; }
          transferred = true;
          child.stderr?.on("data", () => {});
          child.stdin?.on("error", () => { if (!finished) complete(failure("installer-failed")); });
          child.once("error", () => complete(failure("installer-failed")));
          const exited = (code: number | null) => failure(terminal ?? (code === 3 || code === 8 ? "permission-required" : code === 5 ? "installer-cancelled" : "installer-failed"));
          child.once("exit", code => { if (code !== 0) complete(exited(code)); });
          // exit can precede the final stdout data; close is the drained-stdio witness.
          child.once("close", code => complete(code === 0 && finished && !terminal ? undefined : exited(code)));
          child.stdout?.on("data", (data: Buffer) => {
            buffer += data.toString("utf8");
            if (buffer.length > 16384) { complete(failure("release-invalid")); child?.kill(); return; }
            let end: number;
            while ((end = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              try {
                let event;
                try { event = JSON.parse(line); } catch { throw failure("release-invalid"); }
                if (!event || event.schema !== 1) throw failure("release-invalid");
                if (event.phase === "available") { if (event.version !== value.version) throw failure("release-invalid"); available = true; }
                else if (event.phase === "failed") { terminal = nativeErrors.has(event.code) ? event.code : "installer-failed"; throw failure(terminal!); }
                else if (event.phase === "ready") { if (!available || child?.exitCode != null || child?.signalCode != null || settled) throw failure("installer-failed"); child?.stdin?.write("install\n"); }
                else if (event.phase === "finished") { if (!available) throw failure("release-invalid"); finished = true; }
              } catch (error) { complete(failure(nativeError(error))); child?.kill(); return; }
            }
          });
          child.unref();
        });
        await writeNativeOperation(context, selected.directory, value.version, "installed");
      } catch (error) {
        const code = terminal ?? nativeError(error);
        if (code !== "restart-required") { child?.kill(); transferred = false; }
        await writeNativeOperation(context, selected.directory, value.version, "failed", code).catch(() => {});
        if (code !== "restart-required") await discard();
        throw failure(code);
      } finally { listener?.close(); busy = false; }
    },
    async cancel() {
      if (transferred) return;
      generation++;
      abortPreparation?.abort();
      if (stage) await writeNativeOperation(context, stage.directory, stage.release.version, "failed", "installer-cancelled").catch(() => {});
      await discard();
    },
  };
}

/** Platform adapters own only desktop replacement. Engine closure belongs to the caller. */
export function createNativeUpdateAdapter(context: NativeUpdateContext, dependencies: NativeDependencies = {}): DesktopUpdateAdapter {
  const environment = dependencies.environment ?? process.env;
  const helperPath = path.join(context.resourcesDirectory, "updater", "sparkle.app", "Contents", "MacOS", "sparkle");
  const image = environment.APPIMAGE;
  const mac = context.platform === "darwin";
  if (mac) return createMacUpdateAdapter(context, dependencies, helperPath);
  const installation = context.platform === "linux" ? linuxInstallation(context, environment) : undefined;
  const supported = context.isPackaged && ["x64", "arm64"].includes(context.arch) && !!installation;
  let prepared: PreparedDesktopUpdate | undefined;
  let preparing = false;
  let handedOff = false;
  let receiptDirectory: string | undefined;
  let receiptOwner: NativeDirectoryOwner | undefined;
  let linuxStage: { file: string; identity: FileIdentity; original: FileIdentity; release: VerifiedDesktopRelease; directory: string } | undefined;
  let relaunchChild: ChildProcess | undefined;
  async function discardLinuxStage() {
    const staged = linuxStage; linuxStage = undefined;
    if (!staged) return;
    try { const current = await imageIdentity(staged.file); if (current.dev === staged.identity.dev && current.ino === staged.identity.ino) await fs.unlink(staged.file); } catch {}
  }
  function validate(release: VerifiedDesktopRelease) {
    const platform = mac ? "macos" : "linux";
    const expected = `PutioManager-${release.version}-${platform}-${context.arch}${mac ? "-update.zip" : ".AppImage"}`;
    const url = `https://github.com/garbledhamster/putio-manager/releases/download/v${release.version}/${expected}`;
    if (!versionPattern.test(release.version) || !versionPattern.test(context.currentVersion) || !versionIsNewer(release.version, context.currentVersion) || release.platform !== platform || release.arch !== context.arch || release.asset.name !== expected || release.asset.url !== url || !Number.isSafeInteger(release.asset.bytes) || release.asset.bytes <= 0 || !/^[a-f0-9]{64}$/.test(release.asset.sha256)) throw failure("release-invalid");
    if (release.asset.bytes > 2 * 1024 ** 3 || (mac && !validArchiveSignature(release.asset.ed25519))) throw failure("release-invalid");
  }
  return {
    supported,
    async prepare(release, signal, progress) {
      if (!supported || !sameLinuxInstallation(context, environment, installation)) throw failure("unsupported-installation");
      if (preparing || prepared || handedOff) throw failure("installer-busy");
      validate(release);
      if (signal.aborted) throw failure("installer-cancelled");
      preparing = true;
      try {
        if (!mac) {
          await discardLinuxStage();
          const original = await imageIdentity(image!), parent = path.dirname(image!);
          await fs.access(parent, constants.W_OK);
          const space = await fs.statfs(parent);
          if (Number(space.bavail) * Number(space.bsize) < release.asset.bytes + 128 * 1024 ** 2) throw failure("storage-unavailable");
          const directory = await privateUpdateDirectory(context.userDataDirectory, "linux-");
          receiptDirectory = directory;
          receiptOwner = await ownNativeDirectory(directory);
          await writeNativeOperation(context, directory, release.version, "preparing");
          progress({ phase: "downloading" });
          const downloaded = await downloadUpdateAsset(release.asset, directory, signal, percent => progress({ phase: "downloading", percent }), dependencies.fetcher);
          const downloadedIdentity = await imageIdentity(downloaded);
          if (signal.aborted) { await removeNativePayload(receiptOwner, downloadedIdentity, false); throw failure("installer-cancelled"); }
          const file = path.join(parent, `.putio-update-${randomUUID()}.AppImage`);
          try {
            await fs.copyFile(downloaded, file, constants.COPYFILE_EXCL);
            const identity = await imageIdentity(file);
            linuxStage = { file, identity, original, release, directory };
            const handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
            try { await fs.chmod(file, original.mode); await handle.sync(); } finally { await handle.close(); }
            progress({ phase: "verifying" });
            await verifyUpdateFile(file, release.asset, signal);
            linuxStage.identity = await imageIdentity(file);
            if (linuxStage.identity.dev !== original.dev || !sameImage(original, await imageIdentity(image!))) throw failure("installer-failed");
            await (dependencies.syncDirectory ?? syncDirectory)(parent);
            if (signal.aborted) throw failure("installer-cancelled");
          } catch (error) { await discardLinuxStage(); throw error; }
          finally { await removeNativePayload(receiptOwner, downloadedIdentity, false); }
        }
        if (signal.aborted) throw failure("installer-cancelled");
        prepared = { version: release.version, id: randomUUID() };
        await writeNativeOperation(context, receiptDirectory!, release.version, "ready"); progress({ phase: "ready" });
        return { ...prepared };
      } catch (error) {
        const code = updateErrorCode(error);
        if (receiptDirectory) await writeNativeOperation(context, receiptDirectory, release.version, "failed", nativeError(error)).catch(() => {});
        if (["release-invalid", "download-invalid", "signature-invalid", "installer-cancelled", "permission-required", "network", "storage-unavailable"].includes(code)) throw failure(code);
        throw failure(signal.aborted ? "installer-cancelled" : "installer-failed");
      } finally { preparing = false; }
    },
    async handoff(value) {
      if (!prepared || value.id !== prepared.id || value.version !== prepared.version || handedOff) throw failure("installer-failed");
      if (!sameLinuxInstallation(context, environment, installation)) throw failure("unsupported-installation");
      handedOff = true; prepared = undefined;
      let linuxCommitted = false;
      try {
      {
        const staged = linuxStage;
        if (!staged || !sameImage(staged.original, await imageIdentity(image!))) throw failure("installer-failed");
        await verifyUpdateFile(staged.file, staged.release.asset);
        if (!sameImage(staged.identity, await imageIdentity(staged.file))) throw failure("installer-failed");
        await writeNativeOperation(context, staged.directory, value.version, "installing");
        let exited = false;
        await new Promise<void>((resolve, reject) => {
          let ready = false, text = "";
          const timer = setTimeout(() => { relaunchChild?.kill(); reject(failure("installer-failed")); }, Math.max(1, Math.min(30000, dependencies.handoffTimeoutMs ?? 5000)));
          try { relaunchChild = (dependencies.spawn ?? spawn)("/bin/sh", ["-c", linuxRelaunchWaiter, "putio-manager-update", String(process.pid), image!], { shell: false, detached: true, stdio: ["ignore", "pipe", "ignore"] }); }
          catch { clearTimeout(timer); reject(failure("installer-failed")); return; }
          relaunchChild.once("error", () => { exited = true; clearTimeout(timer); reject(failure("installer-failed")); });
          relaunchChild.once("exit", () => { exited = true; clearTimeout(timer); if (!ready) reject(failure("installer-failed")); });
          relaunchChild.stdout!.on("data", data => {
            text += data.toString("utf8");
            if (text.length > 32 || !"ready\n".startsWith(text)) { clearTimeout(timer); relaunchChild?.kill(); reject(failure("installer-failed")); }
            else if (text === "ready\n") { ready = true; clearTimeout(timer); resolve(); }
          });
        });
        await verifyUpdateFile(staged.file, staged.release.asset);
        if (!sameImage(staged.identity, await imageIdentity(staged.file)) || exited || relaunchChild?.exitCode != null || relaunchChild?.signalCode != null || !sameImage(staged.original, await imageIdentity(image!))) throw failure("installer-failed");
        if (exited) throw failure("installer-failed");
        if (!sameLinuxInstallation(context, environment, installation)) throw failure("installer-failed");
        // The complete verified file is already durable on the same filesystem.
        // rename-over-old is the only commit point; never unlink the running image.
        await (dependencies.rename ?? fs.rename)(staged.file, image!);
        linuxCommitted = true; linuxStage = undefined;
        await (dependencies.syncDirectory ?? syncDirectory)(path.dirname(image!));
        const receipt = path.join(staged.directory, "receipt.json");
        await fs.writeFile(receipt + ".tmp", JSON.stringify({ schema: 1, phase: "installed", version: value.version }), { mode: 0o600 });
        await fs.rename(receipt + ".tmp", receipt);
        await writeNativeOperation(context, staged.directory, value.version, "installed");
        if (exited) throw failure("restart-required");
        relaunchChild!.unref(); context.quitApplication();
      }
      } catch (error) {
        const raw = updateErrorCode(error);
        const code = linuxCommitted ? "restart-required" : ["permission-required", "installer-cancelled", "signature-invalid", "download-invalid", "network", "restart-required"].includes(raw) ? raw : "installer-failed";
        // Definite transfer failure can be retried; a timed-out transfer has unknown ownership.
        if (code !== "restart-required") handedOff = false;
        if (!mac && !linuxCommitted) { relaunchChild?.kill(); await discardLinuxStage(); }
        if (receiptDirectory) await writeNativeOperation(context, receiptDirectory, value.version, "failed", code).catch(() => {});
        throw failure(code);
      }
    },
    async cancel() {
      if (handedOff) return;
      if (receiptDirectory && prepared) await writeNativeOperation(context, receiptDirectory, prepared.version, "failed", "installer-cancelled").catch(() => {});
      await discardLinuxStage(); prepared = undefined;
      if (receiptOwner) await removeNativePayload(receiptOwner);
    },
  };
}
