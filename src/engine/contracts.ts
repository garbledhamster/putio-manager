import { Snapshot } from "../shared";

export interface EngineSnapshot extends Snapshot {
  engine: { id: string; label: string; protocolVersion: 2; epoch: string; revision: number };
  connection: { status: "disconnected" | "checking" | "connected" | "connecting" | "error"; message?: string };
  paused: boolean;
  roots: { id: string; label: string }[];
}
export type EngineCommand = "listFiles" | "moveFile" | "renameFile" | "createFolder" | "deleteFile" | "downloadFile" | "downloadZip" | "retryDownload" | "cancelDownloads" | "listTransfers" | "addTransfer" | "cancelTransfer" | "saveSettings" | "prepareRuleDirectory" | "updateRule" | "addRule" | "removeRule" | "checkRules" | "pause" | "resume" | "beginAccountLink" | "cancelAccountLink" | "selectDownloadRoot" | "storageStatus";
export interface EngineClient {
  getSnapshot(): Promise<EngineSnapshot>;
  execute(command: EngineCommand, args?: unknown[], requestId?: string): Promise<unknown>;
  subscribe(listener: (snapshot: EngineSnapshot) => void, onError?: (error: Error) => void): () => void;
  close(): Promise<void>;
}
