/** Shared, allowlisted software-update status. It contains no account or filesystem data. */
export type DesktopUpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "verifying" | "ready" | "preparing" | "installing" | "updated" | "cancelled" | "failed" | "unavailable";
export type DesktopUpdatePlatform = "windows" | "macos" | "linux" | "unsupported";
export type DesktopUpdateError = "network" | "release-invalid" | "signature-invalid" | "download-invalid" | "storage-unavailable" | "permission-required" | "app-busy" | "shutdown-unconfirmed" | "installer-busy" | "installer-cancelled" | "installer-failed" | "restart-required" | "unsupported-installation" | "update-failed";
export interface DesktopUpdateStatus {
  schema: 1;
  source: "github";
  platform: DesktopUpdatePlatform;
  currentVersion: string;
  availableVersion?: string;
  capability: "automatic" | "unavailable";
  phase: DesktopUpdatePhase;
  progressPercent?: number;
  message: string;
  nextAction?: string;
  errorCode?: DesktopUpdateError;
  restartRequired: boolean;
}

/** Private main-process data. Never serialize this through IPC or CLI. */
export interface VerifiedUpdateAsset {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Signed manifest binding to Sparkle's raw archive signature (Mac only). */
  ed25519?: string;
}
export interface VerifiedDesktopRelease {
  version: string;
  platform: Exclude<DesktopUpdatePlatform, "unsupported">;
  arch: "x64" | "arm64";
  asset: VerifiedUpdateAsset;
  assets: readonly VerifiedUpdateAsset[];
}
export interface PreparedDesktopUpdate {
  version: string;
  /** Opaque adapter-owned operation ID, never a renderer-provided path. */
  id: string;
}
export interface DesktopUpdateProgress {
  phase: "downloading" | "verifying" | "ready" | "installing";
  percent?: number;
}
export interface DesktopUpdateAdapter {
  readonly supported: boolean;
  prepare(release: VerifiedDesktopRelease, signal: AbortSignal, progress: (value: DesktopUpdateProgress) => void): Promise<PreparedDesktopUpdate>;
  /** Called only after successful engine closure. It may terminate/relaunch the application. */
  handoff(prepared: PreparedDesktopUpdate): Promise<void>;
  cancel?(): Promise<void>;
}
export interface NativeUpdateContext {
  platform: string;
  arch: string;
  currentVersion: string;
  isPackaged: boolean;
  resourcesDirectory: string;
  applicationDirectory: string;
  executablePath: string;
  userDataDirectory: string;
  /** Root supplies the real application lifecycle; adapters must not touch an engine. */
  quitApplication(): void;
}
