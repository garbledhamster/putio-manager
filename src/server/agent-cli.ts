import { createHash, randomUUID } from "node:crypto";
import { EngineClient, EngineSnapshot } from "../engine/contracts";
import { DownloadJob, Settings } from "../shared";
import { classifyUserError, UserErrorCode, UserMessageContext } from "../messages/user-messages";

/** This module never serializes an engine response directly. All output is built from allowlists. */
const jobStatuses = ["queued", "downloading", "copying", "recovering", "finalizing", "cleaning", "restarting", "waiting", "paused", "interrupted", "failed", "needs-attention", "completed", "unverified", "canceled", "unknown"] as const;
const phases = ["downloading", "copying", "verifying-destination", "unknown"] as const;
const cleanupStatuses = ["not-started", "succeeded", "failed", "unknown", "not-required"] as const;
const accountStatuses = ["disconnected", "checking", "connected", "connecting", "error", "unknown"] as const;
const retryStatuses = new Set(["failed", "canceled", "interrupted", "needs-attention", "waiting"]);
const activeStatuses = new Set(["downloading", "copying", "recovering", "restarting", "finalizing", "cleaning"]);
const throughputStatuses = new Set(["downloading", "copying", "recovering", "restarting"]);
const safeSettingKeys = ["stageDownloads", "stagingMaxBytes", "stagingMinimumFreeBytes", "parallelDownloads", "speedLimitBytesPerSecond", "deleteAfterDownload", "deleteSourceFolders", "autoDownloadInterval", "showToolTips", "autoStartApplication"] as const;
const booleanSettingKeys = new Set<string>(["stageDownloads", "deleteAfterDownload", "deleteSourceFolders", "showToolTips", "autoStartApplication"]);
type SafeSettingKey = typeof safeSettingKeys[number];
type SafeSettings = Partial<Pick<Settings, SafeSettingKey>>;

function member<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}
function bytes(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function rate(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0; }
function sum(values: number[]): number { return values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0); }
function anonymousRef(kind: "job" | "root" | "volume", id: string): string {
  return `${kind}_${createHash("sha256").update(`putio-manager-agent-v1:${kind}:`).update(id).digest("hex").slice(0, 24)}`;
}
export function agentJobRef(id: string): string { return anonymousRef("job", id); }
export function agentRootRef(id: string): string { return anonymousRef("root", id); }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function jobs(snapshot: EngineSnapshot): DownloadJob[] { return Array.isArray(snapshot.jobs) ? snapshot.jobs.filter(job => !!job && typeof job === "object") : []; }
function cleanupEligible(job: DownloadJob): boolean {
  return validId(job.id) && ["completed", "unverified"].includes(job.status) && typeof job.stagingWarning === "string" && job.stagingWarning.length > 0;
}
function retryEligible(job: DownloadJob): boolean {
  return validId(job.id) && (retryStatuses.has(job.status) || cleanupEligible(job));
}

export function resolveJobRef(snapshot: EngineSnapshot, ref: string): DownloadJob | undefined {
  if (!/^job_[0-9a-f]{24}$/.test(ref)) return undefined;
  const matches = jobs(snapshot).filter(job => validId(job.id) && agentJobRef(job.id) === ref);
  return matches.length === 1 ? matches[0] : undefined;
}

function safeJob(job: DownloadJob) {
  const diagnostic = [job.error, job.stagingWarning, job.cleanupWarning].find(value => typeof value === "string" && value.length > 0);
  const error = diagnostic ? safeAgentError(diagnostic, { status: job.status, verification: job.verification, cleanupStatus: job.cleanupStatus, cleanupPending: job.cleanupPending, phase: job.deliveryPhase }) : undefined;
  const recordedVerification = member(job.verification, ["verified", "unverified", "unknown"] as const, "unknown");
  const deliveryVerified = job.status === "completed" && recordedVerification === "verified" && !job.error;
  return {
    ref: validId(job.id) ? agentJobRef(job.id) : null,
    status: member(job.status, jobStatuses, "unknown"),
    phase: member(job.deliveryPhase, phases, "unknown"),
    active: activeStatuses.has(job.status),
    bytesReceived: bytes(job.bytesReceived), totalBytes: bytes(job.totalBytes),
    totalKnown: job.totalKnown === true, bytesCopied: bytes(job.deliveryBytesCopied),
    bytesPerSecond: throughputStatuses.has(job.status) ? rate(job.speed) : 0, attemptCount: bytes(job.attemptCount),
    verification: deliveryVerified ? "verified" : recordedVerification === "unverified" ? "unverified" : "unknown",
    recordedVerification, deliveryVerified,
    cleanupStatus: member(job.cleanupStatus, cleanupStatuses, "unknown"),
    cleanupPending: job.cleanupPending === true,
    sourceDeletionRequested: typeof job.deleteAfterDownload === "boolean" ? job.deleteAfterDownload : null,
    errorCategory: error?.code ?? "none",
    nextAction: error?.nextAction ?? null,
    stagingWarning: typeof job.stagingWarning === "string" && job.stagingWarning.length > 0,
    cleanupWarning: typeof job.cleanupWarning === "string" && job.cleanupWarning.length > 0,
    // Eligibility only describes the visible status. The engine retains all ownership/recovery guards.
    retryEligible: retryEligible(job),
    cleanupEligible: cleanupEligible(job),
    retryRequiresEngineValidation: true,
  };
}

export function safeAnalytics(snapshot: EngineSnapshot) {
  const safeJobs = jobs(snapshot).map(safeJob);
  const byErrorCategory: Record<string, number> = {};
  for (const job of safeJobs) byErrorCategory[job.errorCategory] = (byErrorCategory[job.errorCategory] ?? 0) + 1;
  const counts = <T extends string>(values: readonly T[], field: (job: typeof safeJobs[number]) => T) =>
    Object.fromEntries(values.map(value => [value, safeJobs.filter(job => field(job) === value).length]));
  return {
    jobs: safeJobs.length,
    active: safeJobs.filter(job => job.active).length,
    rules: Array.isArray(snapshot.rules) ? snapshot.rules.length : 0,
    roots: Array.isArray(snapshot.roots) ? snapshot.roots.length : 0,
    byStatus: counts(jobStatuses, job => job.status),
    byPhase: counts(phases, job => job.phase),
    byCleanupStatus: counts(cleanupStatuses, job => job.cleanupStatus),
    byErrorCategory,
    bytesReceived: sum(safeJobs.map(job => job.bytesReceived)),
    totalBytes: sum(safeJobs.map(job => job.totalBytes)),
    bytesCopied: sum(safeJobs.map(job => job.bytesCopied)),
    bytesPerSecond: sum(safeJobs.map(job => job.bytesPerSecond)),
    retryEligible: safeJobs.filter(job => job.retryEligible).length,
    cleanupPending: safeJobs.filter(job => job.cleanupPending).length,
    verified: safeJobs.filter(job => job.deliveryVerified).length,
    warnings: safeJobs.filter(job => job.stagingWarning || job.cleanupWarning).length,
  };
}

export function safeSnapshot(snapshot: EngineSnapshot) {
  const accountStatus = member(snapshot.connection?.status, accountStatuses, "unknown");
  return {
    selectedHost: snapshot.target?.mode === "remote" ? "download-server" : snapshot.target?.mode === "local" ? "this-computer" : "engine-host",
    paused: snapshot.paused === true,
    accountStatus, accountConnected: accountStatus === "connected",
    counts: { jobs: jobs(snapshot).length, rules: Array.isArray(snapshot.rules) ? snapshot.rules.length : 0, roots: Array.isArray(snapshot.roots) ? snapshot.roots.length : 0 },
    analytics: safeAnalytics(snapshot),
  };
}

function settingIsValid(key: SafeSettingKey, value: unknown): boolean {
  if (booleanSettingKeys.has(key)) return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (key === "parallelDownloads") return value >= 1 && value <= 20;
  if (key === "autoDownloadInterval") return value >= 10 && value <= 86400;
  if (key === "stagingMaxBytes") return value > 0;
  return value >= 0;
}
export function normalizeSettingsPatch(input: unknown): SafeSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return undefined;
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key, value]) => !safeSettingKeys.includes(key as SafeSettingKey) || !settingIsValid(key as SafeSettingKey, value))) return undefined;
  return Object.fromEntries(entries) as SafeSettings;
}
function safeSettings(input: Settings): SafeSettings {
  return Object.fromEntries(safeSettingKeys.filter(key => settingIsValid(key, input?.[key])).map(key => [key, input[key]])) as SafeSettings;
}

function safeStorage(value: unknown) {
  const availableBytes = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const volumes = value && typeof value === "object" && "volumes" in value && Array.isArray(value.volumes) ? value.volumes : [];
  return { volumes: volumes.filter(volume => volume && typeof volume === "object").map(volume => ({
    ref: validId(volume.id) ? anonymousRef("volume", volume.id) : null,
    kind: member(volume.kind, ["download", "staging", "unknown"] as const, "unknown"),
    status: member(volume.status, ["ok", "unavailable", "unknown"] as const, "unknown"),
    capacityBytes: availableBytes(volume.capacityBytes), freeBytes: availableBytes(volume.freeBytes), availableBytes: availableBytes(volume.availableBytes),
  })) };
}

const help = {
  commands: ["help", "status", "downloads", "analytics", "storage", "settings", "roots", "retry <job_ref>", "cleanup <job_ref>", "cancel <job_ref>", "pause", "resume", "check-rules", "settings-set --json", "root-select <root_ref>"],
  format: "json", settingsInput: "Read one settings object from stdin with settings-set --json.",
  cleanupScope: "Request guarded temporary staging cleanup for published jobs with a staging cleanup warning.",
  safeSettings: [...safeSettingKeys],
};

/** The classifier shares controlled codes with the app; recovery instructions stay within the CLI. */
export function safeAgentError(error: unknown, context: UserMessageContext = {}): { code: UserErrorCode; nextAction: string } {
  const code = classifyUserError(error, context);
  let nextAction = "Run status and downloads. Have the administrator check the engine if the problem continues.";
  if (["storage-full", "storage-limit", "storage-check", "storage-access", "storage-io", "staging-budget", "staging-reserve", "staging-settings"].includes(code)) nextAction = "Run storage and settings. Correct storage capacity, permissions, or limits before retrying.";
  else if (["server-authorization", "putio-authorization", "credential-storage", "account-link", "account-link-expired"].includes(code)) nextAction = "Have the administrator check the configured credentials and account connection, then run status.";
  else if (code === "server-network") nextAction = "Run service status on the server. After a restart, wait for saved-download checks to finish. If the problem continues, repair the server connection, then run status.";
  else if (["putio-network", "server-version", "server-response", "server-settings"].includes(code)) nextAction = "Have the administrator check the engine connection and compatible versions, then run status.";
  else if (["file-close-unconfirmed", "file-check-required", "recovery-check", "temporary-cleanup", "destination-unverified", "content-mismatch", "source-changed", "partial-missing"].includes(code)) nextAction = "Run downloads. Have the administrator inspect this job before requesting retry or cancel.";
  else if (["parallel-range", "interval-range", "speed-range", "settings-invalid"].includes(code)) nextAction = "Run help and settings. Submit corrected safe settings through settings-set --json stdin.";
  return { code, nextAction };
}
type Parsed = { command: string; ref?: string; patch?: SafeSettings };
function parse(args: readonly string[], input: unknown): Parsed | undefined {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) return undefined;
  let normalized = [...args];
  if (!normalized.length) normalized = ["status"];
  if (normalized[0] === "settings-set") {
    const patch = normalizeSettingsPatch(input);
    return normalized.length === 2 && normalized[1] === "--json" && patch ? { command: "settings-set", patch } : undefined;
  }
  if (input !== undefined) return undefined;
  if (normalized.at(-1) === "--json") normalized.pop();
  const [command, ref] = normalized;
  if (["help", "--help", "-h", "status", "downloads", "analytics", "storage", "settings", "roots", "pause", "resume", "check-rules"].includes(command) && normalized.length === 1) return { command: ["--help", "-h"].includes(command) ? "help" : command };
  if (["retry", "cleanup", "cancel"].includes(command) && normalized.length === 2 && /^job_[0-9a-f]{24}$/.test(ref)) return { command, ref };
  if (command === "root-select" && normalized.length === 2 && /^root_[0-9a-f]{24}$/.test(ref)) return { command, ref };
  return undefined;
}

/** Writes one JSON line. Does not close the supplied client. Input is parsed stdin, never CLI JSON. */
export async function runAgentCommand(client: EngineClient, args: readonly string[], write: (line: string) => void, input?: unknown): Promise<number> {
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  const fail = (code: string, nextAction: string) => { emit({ ok: false, error: { code, nextAction } }); return 1; };
  try {
    const parsed = parse(args, input);
    if (!parsed) return fail("invalid-arguments", "Use help for supported commands and safe settings.");
    if (parsed.command === "help") { emit({ ok: true, value: help }); return 0; }
    if (parsed.command === "storage") {
      const value = await client.execute("storageStatus");
      emit({ ok: true, value: safeStorage(value) }); return 0;
    }
    const snapshot = await client.getSnapshot();
    let value: unknown;
    switch (parsed.command) {
      case "status": value = safeSnapshot(snapshot); break;
      case "downloads": value = { jobs: jobs(snapshot).map(safeJob) }; break;
      case "analytics": value = safeAnalytics(snapshot); break;
      case "settings": value = safeSettings(snapshot.settings); break;
      case "roots": value = { roots: (Array.isArray(snapshot.roots) ? snapshot.roots : []).filter(root => root && validId(root.id)).map(root => ({ ref: agentRootRef(root.id) })) }; break;
      case "pause": case "resume":
        await client.execute(parsed.command); value = safeSnapshot(await client.getSnapshot()); break;
      case "check-rules":
        await client.execute("checkRules"); value = safeSnapshot(await client.getSnapshot()); break;
      case "settings-set":
        await client.execute("saveSettings", [parsed.patch]); value = safeSettings((await client.getSnapshot()).settings); break;
      case "root-select": {
        const matches = (Array.isArray(snapshot.roots) ? snapshot.roots : []).filter(root => root && validId(root.id) && agentRootRef(root.id) === parsed.ref);
        if (matches.length !== 1) return fail("root-not-found", "Run roots and select one current root reference.");
        await client.execute("selectDownloadRoot", [matches[0].id]); value = { selected: true, ref: parsed.ref }; break;
      }
      case "retry": case "cleanup": case "cancel": {
        const job = resolveJobRef(snapshot, parsed.ref!);
        if (!job) return fail("job-not-found", "Run downloads and select one current job reference.");
        if (parsed.command === "retry" && !retryEligible(job)) return fail("retry-not-eligible", "Run downloads and inspect the current job status.");
        if (parsed.command === "cleanup" && !cleanupEligible(job)) return fail("cleanup-not-eligible", "Run downloads. Cleanup requires a completed or unverified job with a temporary staging cleanup warning.");
        if (parsed.command === "retry" || parsed.command === "cleanup") await client.execute("retryDownload", [job.id], randomUUID());
        else await client.execute("cancelDownloads", [[job.id]]);
        const after = await client.getSnapshot();
        const currentJob = resolveJobRef(after, parsed.ref!);
        value = { accepted: true, ref: parsed.ref, job: currentJob ? safeJob(currentJob) : null, status: safeSnapshot(after) }; break;
      }
      default: return fail("invalid-arguments", "Use help for supported commands.");
    }
    emit({ ok: true, value }); return 0;
  } catch (error) {
    const safeError = safeAgentError(error);
    return fail(safeError.code, safeError.nextAction);
  }
}
