import { EngineSnapshot } from "../engine/contracts";

export function isSnapshot(value: unknown): value is EngineSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, any>;
  return (s.fileMovesSupported === undefined || typeof s.fileMovesSupported === "boolean") &&
    !!s.engine && typeof s.engine.id === "string" && typeof s.engine.label === "string" &&
    s.engine.protocolVersion === 2 && typeof s.engine.epoch === "string" &&
    Number.isSafeInteger(s.engine.revision) && s.engine.revision >= 0 &&
    !!s.connection && ["disconnected", "checking", "connected", "connecting", "error"].includes(s.connection.status) &&
    (s.connection.message === undefined || typeof s.connection.message === "string") &&
    typeof s.paused === "boolean" && (s.stagingNotice === undefined || typeof s.stagingNotice === "string") && Array.isArray(s.roots) &&
    s.roots.every((r: any) => r && typeof r.id === "string" && typeof r.label === "string") &&
    !!s.settings && (s.settings.stageDownloads === undefined || typeof s.settings.stageDownloads === "boolean") &&
    (s.settings.stagingDirectory === undefined || typeof s.settings.stagingDirectory === "string") &&
    (s.settings.stagingMaxBytes === undefined || (Number.isSafeInteger(s.settings.stagingMaxBytes) && s.settings.stagingMaxBytes > 0)) &&
    (s.settings.stagingMinimumFreeBytes === undefined || (Number.isSafeInteger(s.settings.stagingMinimumFreeBytes) && s.settings.stagingMinimumFreeBytes >= 0)) &&
    typeof s.settings.downloadDirectory === "string" && Number.isInteger(s.settings.parallelDownloads) &&
    Number.isInteger(s.settings.autoDownloadInterval) && typeof s.settings.deleteAfterDownload === "boolean" &&
    typeof s.settings.showToolTips === "boolean" && typeof s.settings.autoStartApplication === "boolean" &&
    typeof s.hasToken === "boolean" && typeof s.secureStorageAvailable === "boolean" && Array.isArray(s.rules) &&
    s.rules.every((r: any) => r && typeof r.id === "string" && typeof r.folderId === "string" && typeof r.folderName === "string" && typeof r.downloadDirectory === "string" && Array.isArray(r.extensions) && r.extensions.every((e: unknown) => typeof e === "string") && Number.isFinite(r.minSizeBytes) && typeof r.keepFolderStructure === "boolean") &&
    Array.isArray(s.jobs) && s.jobs.every((j: any) => j && typeof j.id === "string" && typeof j.fileId === "string" && typeof j.name === "string" && typeof j.destination === "string" && typeof j.status === "string" && Number.isFinite(j.bytesReceived) && Number.isFinite(j.totalBytes) && Number.isFinite(j.speed) && typeof j.addedAt === "string" && (j.completedAt === undefined || typeof j.completedAt === "string") && (j.error === undefined || typeof j.error === "string") && (j.retryAt === undefined || (typeof j.retryAt === "string" && Number.isFinite(Date.parse(j.retryAt)))) && (j.attemptCount === undefined || (Number.isSafeInteger(j.attemptCount) && j.attemptCount >= 0)) && (j.totalKnown === undefined || typeof j.totalKnown === "boolean") && (j.verification === undefined || ["verified", "unverified"].includes(j.verification)) && (j.cleanupStatus === undefined || ["not-started", "succeeded", "failed", "unknown", "not-required"].includes(j.cleanupStatus)) && (j.cleanupWarning === undefined || typeof j.cleanupWarning === "string") && (j.cleanupPending === undefined || typeof j.cleanupPending === "boolean") && (j.deliveryPhase === undefined || ["downloading", "copying", "verifying-destination"].includes(j.deliveryPhase)) && (j.deliveryBytesCopied === undefined || (Number.isSafeInteger(j.deliveryBytesCopied) && j.deliveryBytesCopied >= 0)) && (j.stagingWarning === undefined || typeof j.stagingWarning === "string")) && typeof s.scanStatus === "string";
}
export const commands = new Set(["listFiles", "moveFile", "renameFile", "createFolder", "deleteFile", "downloadFile", "downloadZip", "retryDownload", "cancelDownloads", "listTransfers", "addTransfer", "cancelTransfer", "saveSettings", "addRule", "updateRule", "prepareRuleDirectory", "removeRule", "checkRules", "pause", "resume", "beginAccountLink", "cancelAccountLink", "selectDownloadRoot", "storageStatus"]);
