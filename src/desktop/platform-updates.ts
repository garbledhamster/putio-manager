import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, promises as fs } from "node:fs";
import path from "node:path";
import { downloadUpdateAsset, privateUpdateDirectory, verifyUpdateFile } from "./update-transfer";
import { updateErrorCode } from "./update-errors";
import type { UpdateFetch } from "./update-release";
import { validArchiveSignature } from "./update-release";
import type { DesktopUpdateAdapter, DesktopUpdateProgress, NativeUpdateContext, PreparedDesktopUpdate, VerifiedDesktopRelease } from "./update-types";

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
async function syncDirectory(directory: string) { const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); try { await handle.sync(); } finally { await handle.close(); } }
// Positional arguments are a verified PID and this installation's verified path.
// Never kill a PID: timeout exits if a reused PID or stalled parent remains alive.
const linuxRelaunchWaiter = 'printf "ready\\n"; exec >/dev/null 2>&1; n=0; while kill -0 "$1" 2>/dev/null; do n=$((n+1)); [ "$n" -ge 300 ] && exit 1; /bin/sleep 0.1; done; exec "$2" --enable-sandbox';

/** Platform adapters own only desktop replacement. Engine closure belongs to the caller. */
export function createNativeUpdateAdapter(context: NativeUpdateContext, dependencies: NativeDependencies = {}): DesktopUpdateAdapter {
  const environment = dependencies.environment ?? process.env;
  const helperPath = path.join(context.resourcesDirectory, "updater", "sparkle.app", "Contents", "MacOS", "sparkle");
  const image = environment.APPIMAGE;
  const mac = context.platform === "darwin";
  const supported = context.isPackaged && ["x64", "arm64"].includes(context.arch) && (mac ? existsSync(helperPath) : context.platform === "linux" && !!image && (() => { try { const s = lstatSync(image); return s.isFile() && !s.isSymbolicLink() && image.endsWith(".AppImage"); } catch { return false; } })());
  let prepared: PreparedDesktopUpdate | undefined;
  let child: ChildProcess | undefined;
  let preparing = false;
  let handedOff = false;
  let receiptDirectory: string | undefined;
  let cancelOperation: (() => void) | undefined;
  let handoffError: string | undefined;
  let settleHandoff: ((code: number | null) => void) | undefined;
  let childExited = false;
  let terminalError: string | undefined;
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
      if (!supported) throw failure("unsupported-installation");
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
          progress({ phase: "downloading" });
          const downloaded = await downloadUpdateAsset(release.asset, directory, signal, percent => progress({ phase: "downloading", percent }), dependencies.fetcher);
          if (signal.aborted) throw failure("installer-cancelled");
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
          finally { await fs.unlink(downloaded).catch(() => {}); }
        } else {
          childExited = false; terminalError = undefined; handoffError = undefined;
          receiptDirectory = await privateUpdateDirectory(context.userDataDirectory, "mac-");
          if (signal.aborted) throw failure("installer-cancelled");
          await new Promise<void>((resolve, reject) => {
            let buffer = "", available = false, ready = false, settled = false;
            let running: ChildProcess;
            const finish = (error?: Error) => {
              if (running && child !== running) return;
              if (error) {
                terminalError = error.message;
                prepared = undefined;
                if (handedOff) { handoffError = "restart-required"; settleHandoff?.(null); return; }
              }
              if (settled) { if (error && !childExited) running?.kill(); return; }
              settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
              if (error) { child?.kill(); reject(error); } else resolve();
            };
            const abort = () => finish(failure("installer-cancelled"));
            const timeout = setTimeout(() => finish(failure("network")), 30 * 60 * 1000);
            const feed = `https://github.com/garbledhamster/putio-manager/releases/download/v${release.version}/appcast-${context.arch}.xml`;
            try { child = (dependencies.spawn ?? spawn)(helperPath, [context.applicationDirectory, "--check-immediately", "--user-agent-name", "PutioManager", "--feed-url", feed], {
              shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
              env: { ...environment, PUTIO_UPDATER_EXPECTED_VERSION: release.version, PUTIO_UPDATER_EXPECTED_URL: release.asset.url, PUTIO_UPDATER_EXPECTED_SIGNATURE: release.asset.ed25519!, PUTIO_UPDATER_EXPECTED_BYTES: String(release.asset.bytes), PUTIO_UPDATER_RECEIPT: path.join(receiptDirectory!, "receipt.json") },
            }); } catch { clearTimeout(timeout); terminalError = "installer-failed"; reject(failure("installer-failed")); return; }
            running = child;
            cancelOperation = abort; signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) { abort(); return; }
            child.stderr?.on("data", () => {});
            child.stdin?.on("error", () => { if (!handedOff) finish(failure("installer-failed")); });
            child.on("error", () => finish(failure("installer-failed")));
            child.on("exit", (code) => {
              if (child !== running) return;
              childExited = true;
              if (handedOff) { settleHandoff?.(code); return; }
              terminalError ??= code === 3 || code === 8 ? "permission-required" : code === 5 ? "installer-cancelled" : "installer-failed";
              prepared = undefined;
              if (!ready) finish(failure(code === 3 || code === 8 ? "permission-required" : code === 5 ? "installer-cancelled" : "installer-failed"));
              else if (!handedOff) { prepared = undefined; ready = false; }
            });
            child.stdout?.on("data", (data: Buffer) => {
              if (child !== running || childExited) return;
              buffer += data.toString("utf8");
              if (buffer.length > 16384) { finish(failure("release-invalid")); return; }
              let boundary: number;
              while ((boundary = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
                let event: { schema?: unknown; phase?: unknown; version?: unknown; percent?: unknown; code?: unknown };
                try { event = JSON.parse(line); } catch { finish(failure("release-invalid")); return; }
                if (!event || event.schema !== 1) { finish(failure("release-invalid")); return; }
                if (handedOff) {
                  if (event.phase === "failed") handoffError = ["release-invalid", "download-invalid", "signature-invalid", "network", "permission-required", "installer-cancelled"].includes(String(event.code)) ? String(event.code) : "installer-failed";
                  continue;
                }
                if (event.phase === "available") { if (event.version !== release.version) { finish(failure("release-invalid")); return; } available = true; }
                else if (event.phase === "failed") { finish(failure(["release-invalid", "download-invalid", "signature-invalid", "network", "permission-required", "installer-cancelled"].includes(String(event.code)) ? String(event.code) : "installer-failed")); return; }
                else if (event.phase === "ready") { if (!available) { finish(failure("release-invalid")); return; } ready = true; finish(); }
                else if (["downloading", "verifying"].includes(String(event.phase))) {
                  const value: DesktopUpdateProgress = { phase: event.phase as "downloading" | "verifying" };
                  if (typeof event.percent === "number" && Number.isFinite(event.percent)) value.percent = Math.max(0, Math.min(100, event.percent));
                  progress(value);
                }
              }
            });
          });
        }
        if (signal.aborted) throw failure("installer-cancelled");
        if (mac && (childExited || terminalError || child?.exitCode != null || child?.signalCode != null)) throw failure(terminalError ?? "installer-failed");
        prepared = { version: release.version, id: randomUUID() }; progress({ phase: "ready" });
        return { ...prepared };
      } catch (error) {
        const code = updateErrorCode(error);
        if (["release-invalid", "download-invalid", "signature-invalid", "installer-cancelled", "permission-required", "network", "storage-unavailable"].includes(code)) throw failure(code);
        throw failure(signal.aborted ? "installer-cancelled" : "installer-failed");
      } finally { preparing = false; }
    },
    async handoff(value) {
      if (!prepared || value.id !== prepared.id || value.version !== prepared.version || handedOff) throw failure("installer-failed");
      if (mac && (childExited || terminalError || child?.exitCode != null || child?.signalCode != null)) { prepared = undefined; throw failure(terminalError ?? "installer-failed"); }
      handedOff = true; prepared = undefined; cancelOperation = undefined;
      let linuxCommitted = false;
      try {
      if (mac) {
        if (!child?.stdin?.writable) throw failure("installer-failed");
        await new Promise<void>((resolve, reject) => {
          let finished = false;
          const milliseconds = dependencies.handoffTimeoutMs ?? 120000;
          const timer = setTimeout(() => { handoffError = "restart-required"; settleHandoff?.(null); }, Math.max(1, Math.min(600000, milliseconds)));
          settleHandoff = code => {
            if (finished) return;
            finished = true; clearTimeout(timer); settleHandoff = undefined;
            if (code === 0 && !handoffError) resolve();
            else reject(failure(handoffError ?? (code === 3 || code === 8 ? "permission-required" : code === 5 ? "installer-cancelled" : "installer-failed")));
          };
          if (childExited || child!.exitCode != null || child!.signalCode != null) { settleHandoff(null); return; }
          child!.stdin!.write("install\n", error => { if (error) { handoffError = "installer-failed"; settleHandoff?.(null); } });
          child!.unref();
          // Sparkle requests ordinary host termination. Its helper survives host exit.
        });
      } else {
        const staged = linuxStage;
        if (!staged || !sameImage(staged.original, await imageIdentity(image!))) throw failure("installer-failed");
        await verifyUpdateFile(staged.file, staged.release.asset);
        if (!sameImage(staged.identity, await imageIdentity(staged.file))) throw failure("installer-failed");
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
        // The complete verified file is already durable on the same filesystem.
        // rename-over-old is the only commit point; never unlink the running image.
        await (dependencies.rename ?? fs.rename)(staged.file, image!);
        linuxCommitted = true; linuxStage = undefined;
        await (dependencies.syncDirectory ?? syncDirectory)(path.dirname(image!));
        const receipt = path.join(staged.directory, "receipt.json");
        await fs.writeFile(receipt + ".tmp", JSON.stringify({ schema: 1, phase: "installed", version: value.version }), { mode: 0o600 });
        await fs.rename(receipt + ".tmp", receipt);
        if (exited) throw failure("restart-required");
        relaunchChild!.unref(); context.quitApplication();
      }
      } catch (error) {
        const raw = updateErrorCode(error);
        const code = linuxCommitted ? "restart-required" : ["permission-required", "installer-cancelled", "signature-invalid", "download-invalid", "network", "restart-required"].includes(raw) ? raw : "installer-failed";
        // Definite transfer failure can be retried; a timed-out transfer has unknown ownership.
        if (code !== "restart-required") handedOff = false;
        if (!mac && !linuxCommitted) { relaunchChild?.kill(); await discardLinuxStage(); }
        throw failure(code);
      }
    },
    async cancel() {
      if (handedOff) return;
      if (mac && prepared && child?.stdin?.writable) {
        const running = child;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { running.kill(); resolve(); }, 2000);
          running.once("exit", () => { clearTimeout(timer); resolve(); });
          running.stdin!.end("cancel\n");
        });
      } else { cancelOperation?.(); child?.kill(); }
      await discardLinuxStage(); prepared = undefined;
      if (receiptDirectory) await fs.rm(receiptDirectory, { recursive: true, force: true });
    },
  };
}
