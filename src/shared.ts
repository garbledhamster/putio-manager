import type { DesktopUpdateStatus } from "./desktop/update-types";
export interface RemoteFile {
  id: string;
  parentId: string;
  name: string;
  size: number;
  sizeKnown?: boolean;
  crc32?: string;
  sha1?: string;
  updatedAt?: string;
  isFolder: boolean;
  contentType: string;
}
export interface RemoteTransfer {
  id: string;
  name: string;
  size: number;
  peers: number;
  uploaded: number;
  createdAt: string;
  status: string;
}
export type RuleSchedule = { kind: "interval"; seconds: number } | { kind: "daily"; time: string } | { kind: "weekly"; day: number; time: string };
export interface DownloadOptions { deleteSourceFolders?: boolean; deleteAfterDownload?: boolean; speedLimitBytesPerSecond?: number }
export interface Settings {
  downloadDirectory: string;
  stageDownloads: boolean;
  stagingDirectory: string;
  stagingMaxBytes: number;
  stagingMinimumFreeBytes: number;
  parallelDownloads: number;
  speedLimitBytesPerSecond: number;
  deleteAfterDownload: boolean;
  deleteSourceFolders: boolean;
  autoDownloadInterval: number;
  showToolTips: boolean;
  autoStartApplication: boolean;
}
export interface AutoDownloadRule {
  id: string;
  folderId: string;
  folderName: string;
  downloadDirectory: string;
  extensions: string[];
  minSizeBytes: number;
  keepFolderStructure: boolean;
  schedule?: RuleSchedule;
  deleteAfterDownload?: boolean;
  deleteSourceFolders?: boolean;
  speedLimitBytesPerSecond?: number;
}
export interface DownloadJob {
  id: string;
  fileId: string;
  name: string;
  destination: string;
  status: string;
  bytesReceived: number;
  totalBytes: number;
  speed: number;
  addedAt: string;
  deleteAfterDownload?: boolean;
  deleteSourceFolders?: boolean;
  speedLimitBytesPerSecond?: number;
  deliveryPhase?: "downloading" | "copying" | "verifying-destination";
  deliveryBytesCopied?: number;
  stagingWarning?: string;
  verification?: "verified" | "unverified";
  cleanupStatus?: "not-started" | "succeeded" | "failed" | "unknown" | "not-required";
  cleanupWarning?: string;
  cleanupPending?: boolean;
  totalKnown?: boolean;
  retryAt?: string;
  attemptCount?: number;
  completedAt?: string;
  error?: string;
}
export interface Snapshot {
  fileMovesSupported?: boolean;
  settings: Settings;
  hasToken: boolean;
  secureStorageAvailable: boolean;
  rules: AutoDownloadRule[];
  jobs: DownloadJob[];
  scanStatus: string;
  stagingNotice?: string;
  target?: { mode: "local" | "remote"; label: string; status: "connected" | "connecting" | "error"; message?: string };
  account?: { status: "disconnected" | "checking" | "connected" | "connecting" | "error"; message?: string };
  roots?: { id: string; label: string }[];
  paused?: boolean;
  timeZone: string;
  nextRuleRuns: Record<string, string>;
}
export interface PutioBridge {
  getDesktopUpdateStatus(): Promise<DesktopUpdateStatus>;
  checkDesktopUpdate(): Promise<DesktopUpdateStatus>;
  installDesktopUpdate(): Promise<DesktopUpdateStatus>;
  cancelDesktopUpdate(): Promise<DesktopUpdateStatus>;
  onDesktopUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  getState(): Promise<Snapshot>;
  connectAccount(): Promise<Snapshot>;
  getRemoteConnection(): Promise<{ url: string; label: string; hasCredential: boolean }>;
  configureRemote(config: { url: string; label: string; token?: string }): Promise<{ url: string; label: string; hasCredential: boolean }>;
  selectEngine(mode: "local" | "remote"): Promise<Snapshot>;
  selectDownloadRoot(id: string, relative?: string): Promise<Snapshot>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  retryDownload(id: string): Promise<void>;
  listFiles(parentId: string): Promise<RemoteFile[]>;
  moveFile(id: string, parentId: string): Promise<void>;
  renameFile(id: string, name: string): Promise<void>;
  createFolder(parentId: string, name: string): Promise<void>;
  deleteFile(id: string): Promise<void>;
  downloadFile(fileId: string, options?: DownloadOptions): Promise<void>;
  downloadZip(fileId: string, options?: DownloadOptions): Promise<void>;
  cancelDownloads(ids?: string[]): Promise<void>;
  listTransfers(): Promise<RemoteTransfer[]>;
  addTransfer(url: string, parentId: string): Promise<void>;
  cancelTransfer(id: string): Promise<void>;
  saveSettings(
    patch: Partial<Settings> & { token?: string },
  ): Promise<Snapshot>;
  chooseDirectory(): Promise<string | null>;
  openDownloadDirectory(): Promise<void>;
  openTokenPage(): Promise<void>;
  prepareRuleDirectory(relative: string): Promise<string>;
  addRule(rule: Omit<AutoDownloadRule, "id">): Promise<void>;
  updateRule(id: string, rule: Omit<AutoDownloadRule, "id">): Promise<void>;
  getDesktopIntegration(): Promise<{startupSupported: boolean; startupEnabled: boolean; magnetSupported: boolean; magnetRegistered: boolean}>;
  setMagnetRegistration(enabled: boolean): Promise<{startupSupported: boolean; startupEnabled: boolean; magnetSupported: boolean; magnetRegistered: boolean}>;
  removeRule(id: string): Promise<void>;
  checkRules(): Promise<void>;
  onMagnetDestination(listener: (id: string) => void): void;
  listMagnetFolders(id: string, parent: string): Promise<{ id: string; name: string }[]>;
  finishMagnetDestination(id: string, folder: string | null): Promise<void>;
  onState(listener: (state: Snapshot) => void): () => void;
}
declare global {
  interface Window {
    putio: PutioBridge;
  }
}

/** Accept only the put.io device authorization page and its single connection code. */
export function validateAccountLink(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid account link.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid account link."); }
  const codes = url.searchParams.getAll("code");
  if (url.origin !== "https://app.put.io" || url.username || url.password || url.pathname !== "/link" || url.hash || [...url.searchParams.keys()].length !== 1 || codes.length !== 1 || !/^[a-z0-9-]{4,64}$/i.test(codes[0])) throw new Error("Invalid account link.");
  return url.toString();
}
