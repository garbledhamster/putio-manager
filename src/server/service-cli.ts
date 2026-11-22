import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const unit = "putio-manager.service";
const actions = ["status", "start", "stop", "restart"] as const;
const states = ["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "refreshing", "unknown"] as const;
type Action = typeof actions[number];
type ServiceState = typeof states[number];
export type ServiceRunner = (file: "systemctl", args: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;
/** A reader returns raw kernel metadata for normalization; it accepts no paths or process IDs. */
export type ServiceMetadataReader = (scope: "system" | "user") => Promise<unknown>;
type ProcessMetadata = { processState: "running" | "not-running" | "unavailable"; elapsedSeconds: number | null; cpuSeconds: number | null; bytesRead: number | null; applicationReady: null; readiness: "not-verified" };

/** No shell, elevation, custom units, configuration, or engine credentials are involved. */
const fixedFileRunner = (file: "systemctl" | "getconf", args: readonly string[], timeout = 15000): Promise<{ stdout: string; exitCode: number }> => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
    if (error && (typeof error.code !== "number" || error.killed || error.signal)) { reject(new Error("Service action unavailable.")); return; }
    resolve({ stdout, exitCode: error && typeof error.code === "number" ? error.code : 0 });
  });
});
const systemRunner: ServiceRunner = fixedFileRunner;

function emptyProcessMetadata(processState: ProcessMetadata["processState"] = "unavailable"): ProcessMetadata {
  return { processState, elapsedSeconds: null, cpuSeconds: null, bytesRead: null, applicationReady: null, readiness: "not-verified" };
}
function validPid(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,6})$/.test(value) && Number(value) <= 4194304;
}
function kernelCounter(value: string): number | undefined {
  if (!/^[0-9]{1,16}$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function processMetadata(raw: unknown): ProcessMetadata {
  if (!raw || typeof raw !== "object") return emptyProcessMetadata();
  const data = raw as { pid?: unknown; stat?: unknown; io?: unknown; uptime?: unknown; clockTicksPerSecond?: unknown };
  if (!validPid(data.pid)) return emptyProcessMetadata();
  if (data.pid === "0") return emptyProcessMetadata("not-running");
  if ([data.stat, data.io, data.uptime].some(value => typeof value !== "string" || value.length > 8192)) return emptyProcessMetadata();
  const hz = data.clockTicksPerSecond;
  if (typeof hz !== "number" || !Number.isSafeInteger(hz) || hz < 1 || hz > 1000000) return emptyProcessMetadata();
  const stat = data.stat as string;
  // The kernel's comm field can contain spaces and parentheses. It is never returned.
  const commandStart = stat.indexOf("("); const commandEnd = stat.lastIndexOf(")");
  if (commandStart < 1 || commandEnd < commandStart || stat.slice(0, commandStart).trim() !== data.pid) return emptyProcessMetadata();
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^[RSDTtZXxKWPI]$/.test(fields[0])) return emptyProcessMetadata();
  const userTicks = kernelCounter(fields[11]), systemTicks = kernelCounter(fields[12]), startTicks = kernelCounter(fields[19]);
  const io = (data.io as string).match(/^read_bytes:\s*([0-9]+)\s*$/m);
  const bytesRead = io ? kernelCounter(io[1]) : undefined;
  const uptime = (data.uptime as string).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+[0-9]+(?:\.[0-9]+)?$/);
  const uptimeSeconds = uptime ? Number(uptime[1]) : NaN;
  if (userTicks === undefined || systemTicks === undefined || startTicks === undefined || bytesRead === undefined || !Number.isFinite(uptimeSeconds) || uptimeSeconds > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(userTicks + systemTicks)) return emptyProcessMetadata();
  const cpuSeconds = (userTicks + systemTicks) / hz;
  const elapsedSeconds = uptimeSeconds - startTicks / hz;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > Number.MAX_SAFE_INTEGER || !Number.isFinite(cpuSeconds)) return emptyProcessMetadata();
  // read_bytes is cumulative kernel process I/O, not download traffic or current throughput.
  return { processState: /^[RSDKWPI]$/.test(fields[0]) ? "running" : "not-running", elapsedSeconds, cpuSeconds, bytesRead, applicationReady: null, readiness: "not-verified" };
}

const kernelMetadataReader: ServiceMetadataReader = async scope => {
  const prefix = scope === "user" ? ["--user", "--no-ask-password"] : ["--no-ask-password"];
  const shown = await fixedFileRunner("systemctl", [...prefix, "show", "--property=MainPID", "--value", unit], 3000);
  if (!validResult(shown) || shown.exitCode !== 0) throw new Error("Process metadata unavailable.");
  const pid = shown.stdout.trim();
  if (!validPid(pid)) throw new Error("Process metadata unavailable.");
  if (pid === "0") return { pid };
  // Every path is a fixed kernel metadata file, or contains only the validated numeric PID.
  const [stat, io, uptime, ticks] = await Promise.all([
    readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal: AbortSignal.timeout(2000) }),
    readFile(`/proc/${pid}/io`, { encoding: "utf8", signal: AbortSignal.timeout(2000) }),
    readFile("/proc/uptime", { encoding: "utf8", signal: AbortSignal.timeout(2000) }),
    fixedFileRunner("getconf", ["CLK_TCK"], 3000),
  ]);
  if (!validResult(ticks) || ticks.exitCode !== 0 || !/^[1-9][0-9]{0,6}$/.test(ticks.stdout.trim())) throw new Error("Process metadata unavailable.");
  return { pid, stat, io, uptime, clockTicksPerSecond: Number(ticks.stdout.trim()) };
};

function parse(args: readonly string[]): { action: Action; user: boolean } | undefined {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string") || args.length < 1 || args.length > 2) return undefined;
  if (!actions.includes(args[0] as Action) || (args.length === 2 && args[1] !== "--user")) return undefined;
  return { action: args[0] as Action, user: args.length === 2 };
}
function validResult(result: { stdout: string; exitCode: number }): boolean {
  return !!result && typeof result.stdout === "string" && Buffer.byteLength(result.stdout) <= 4096 && Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255;
}
function readState(result: { stdout: string; exitCode: number }): ServiceState {
  if (!validResult(result)) return "unknown";
  const state = result.stdout.trim();
  if (!states.includes(state as ServiceState) || (state === "active" && result.exitCode !== 0)) return "unknown";
  return state as ServiceState;
}

/** Args follow `service`: status|start|stop|restart [--user]. Writes one controlled JSON line.
 * Restart affects only this service. It does not reboot the machine or verify that jobs resumed.
 */
export async function runServiceCommand(args: readonly string[], write: (line: string) => void, runner?: ServiceRunner, metadataReader?: ServiceMetadataReader): Promise<number> {
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  const fail = (code: string, nextAction: string, value?: unknown) => {
    emit({ ok: false, error: { code, nextAction }, ...(value === undefined ? {} : { value }) }); return 1;
  };
  if (Array.isArray(args) && args.length === 1 && ["help", "--help"].includes(args[0])) {
    emit({ ok: true, value: {
      service: unit, platform: "linux", defaultScope: "system",
      commands: ["service status [--user]", "service start [--user]", "service stop [--user]", "service restart [--user]"],
      restartScope: "Restart affects only this service. It does not reboot the machine.",
      permissions: "Use existing operating system permissions for the fixed service.",
      engineConfigurationRequired: false, queueResumption: "not-verified",
      processMetrics: "Status can report cumulative kernel process I/O. Bytes read are not download traffic. Process activity does not verify application readiness.",
    } }); return 0;
  }
  const parsed = parse(args);
  if (!parsed) return fail("invalid-service-arguments", "Use service status|start|stop|restart with an optional trailing --user.");
  if (!runner && process.platform !== "linux") return fail("service-platform-unsupported", "Run this service command on the Linux download server using its existing operating system permissions.");
  const run = runner ?? systemRunner;
  const prefix = parsed.user ? ["--user", "--no-ask-password"] : ["--no-ask-password"];
  let acknowledged = false;
  let status: ServiceState = "unknown";
  let processInfo = emptyProcessMetadata();
  const value = () => ({
    service: unit, scope: parsed.user ? "user" : "system", requested: parsed.action,
    acknowledged, status, verified: acknowledged && status !== "unknown" && (parsed.action === "status" || status === (parsed.action === "stop" ? "inactive" : "active")),
    running: status === "active" ? true : status === "inactive" ? false : null,
    rebootsMachine: false, queueResumption: "not-verified",
    ...(parsed.action === "status" ? { process: processInfo } : {}),
  });
  try {
    if (parsed.action !== "status") {
      const result = await run("systemctl", [...prefix, parsed.action, unit]);
      acknowledged = validResult(result) && result.exitCode === 0;
    }
    status = readState(await run("systemctl", [...prefix, "is-active", unit]));
    if (parsed.action === "status") {
      acknowledged = status !== "unknown";
      const readMetadata = metadataReader ?? (!runner ? kernelMetadataReader : undefined);
      if (readMetadata) {
        try { processInfo = processMetadata(await readMetadata(parsed.user ? "user" : "system")); }
        catch { processInfo = emptyProcessMetadata(); }
      }
    }
    const result = value();
    if (!acknowledged) return fail(parsed.action === "status" ? "service-state-unverified" : "service-action-failed", "Check service status and have the administrator check service installation and operating system permissions.", result);
    if (!result.verified) return fail("service-state-unverified", "Run service status again. Have the administrator check the service if the expected state does not appear.", result);
    emit({ ok: true, value: result }); return 0;
  } catch {
    return fail("service-control-unavailable", "Have the administrator check that systemctl and the fixed service are available with the current operating system permissions.", value());
  }
}
