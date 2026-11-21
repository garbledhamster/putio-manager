import { promises as fs } from "node:fs";
import path from "node:path";
import { AutoDownloadRule, Settings } from "../shared";
export const defaultSettings: Settings = {
  downloadDirectory: "",
  stageDownloads: false,
  stagingDirectory: "",
  stagingMaxBytes: 20 * 1024 ** 3,
  stagingMinimumFreeBytes: 10 * 1024 ** 3,
  parallelDownloads: 1,
  speedLimitBytesPerSecond: 0,
  deleteAfterDownload: false,
  deleteSourceFolders: false,
  autoDownloadInterval: 60,
  showToolTips: true,
  autoStartApplication: false,
};
export function validSchedule(s: any): boolean {
  if (s === undefined) return true;
  if (!s || typeof s !== "object") return false;
  if (s.kind === "interval") return Number.isSafeInteger(s.seconds) && s.seconds >= 10 && s.seconds <= 86400;
  if (s.kind !== "daily" && s.kind !== "weekly") return false;
  return typeof s.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) && (s.kind !== "weekly" || (Number.isInteger(s.day) && s.day >= 0 && s.day <= 6));
}
export interface CredentialAdapter {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export class SettingsStore {
  settings: Settings = { ...defaultSettings };
  rules: AutoDownloadRule[] = [];
  token = "";
  constructor(
    private directory: string,
    private credentials: CredentialAdapter,
  ) {}
  async load() {
    try {
      const data = JSON.parse(
        await fs.readFile(path.join(this.directory, "settings.json"), "utf8"),
      );
      const settings = { ...defaultSettings, ...data.settings };
      if (
        typeof settings.stageDownloads !== "boolean" ||
        typeof settings.stagingDirectory !== "string" ||
        (settings.stagingDirectory && !path.isAbsolute(settings.stagingDirectory)) ||
        !Number.isSafeInteger(settings.stagingMaxBytes) || settings.stagingMaxBytes <= 0 ||
        !Number.isSafeInteger(settings.stagingMinimumFreeBytes) || settings.stagingMinimumFreeBytes < 0 ||
        typeof settings.downloadDirectory !== "string" ||
        (settings.downloadDirectory &&
          !path.isAbsolute(settings.downloadDirectory)) ||
        !Number.isInteger(settings.parallelDownloads) ||
        settings.parallelDownloads < 1 ||
        settings.parallelDownloads > 20 ||
        !Number.isSafeInteger(settings.speedLimitBytesPerSecond) || settings.speedLimitBytesPerSecond < 0 ||
        !Number.isInteger(settings.autoDownloadInterval) ||
        settings.autoDownloadInterval < 10 ||
        settings.autoDownloadInterval > 86400 ||
        typeof settings.deleteAfterDownload !== "boolean" ||
        typeof settings.deleteSourceFolders !== "boolean" ||
        typeof settings.showToolTips !== "boolean" ||
        typeof settings.autoStartApplication !== "boolean"
      )
        throw new Error("Invalid saved settings.");
      if (
        !Array.isArray(data.rules) ||
        data.rules.some(
          (r: any) =>
            !r ||
            typeof r.id !== "string" ||
            typeof r.folderId !== "string" ||
            !/^\d+$/.test(r.folderId) ||
            typeof r.folderName !== "string" ||
            typeof r.downloadDirectory !== "string" ||
            !path.isAbsolute(r.downloadDirectory) ||
            !Array.isArray(r.extensions) ||
            r.extensions.some(
              (e: unknown) =>
                typeof e !== "string" || !/^\.?[a-z0-9]+$/i.test(e),
            ) ||
            !Number.isSafeInteger(r.minSizeBytes) ||
            r.minSizeBytes < 0 ||
            typeof r.keepFolderStructure !== "boolean" ||
            (r.deleteSourceFolders !== undefined && typeof r.deleteSourceFolders !== "boolean") ||
            (r.deleteAfterDownload !== undefined && typeof r.deleteAfterDownload !== "boolean") ||
            (r.speedLimitBytesPerSecond !== undefined && (!Number.isSafeInteger(r.speedLimitBytesPerSecond) || r.speedLimitBytesPerSecond < 0)) ||
            !validSchedule(r.schedule),
        )
      )
        throw new Error("Invalid saved rules.");
      this.settings = settings;
      this.rules = data.rules;
      if (data.token && this.credentials.available())
        this.token = this.credentials.decrypt(
          Buffer.from(data.token, "base64"),
        );
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new Error("Could not read saved settings.");
    }
  }
  private writes: Promise<void> = Promise.resolve();
  async save() {
    this.writes = this.writes.catch(() => {}).then(() => this.write());
    return this.writes;
  }
  private async write() {
    await fs.mkdir(this.directory, { recursive: true });
    const data = {
      settings: this.settings,
      rules: this.rules,
      token:
        this.token && this.credentials.available()
          ? this.credentials.encrypt(this.token).toString("base64")
          : undefined,
    };
    const file = path.join(this.directory, "settings.json");
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
}
