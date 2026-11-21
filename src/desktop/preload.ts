import { contextBridge, ipcRenderer } from "electron";
import type { PutioBridge } from "../shared";
const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args);
const bridge: PutioBridge = {
  getState: () => invoke("getState"),
  getDesktopIntegration: () => invoke("getDesktopIntegration"),
  setMagnetRegistration: enabled => invoke("setMagnetRegistration", enabled),
  connectAccount: () => invoke("connectAccount"),
  getRemoteConnection: () => invoke("getRemoteConnection"),
  configureRemote: (config) => invoke("configureRemote", config),
  selectEngine: (mode) => invoke("selectEngine", mode),
  selectDownloadRoot: (id, relative) => invoke("selectDownloadRoot", id, relative),
  pause: () => invoke("pause"),
  resume: () => invoke("resume"),
  retryDownload: (id) => invoke("retryDownload", id),
  listFiles: (id) => invoke("listFiles", id),
  moveFile: (id, parentId) => invoke("moveFile", id, parentId),
  renameFile: (id, name) => invoke("renameFile", id, name),
  createFolder: (id, name) => invoke("createFolder", id, name),
  deleteFile: (id) => invoke("deleteFile", id),
  downloadFile: (id, options) => invoke("downloadFile", id, options),
  downloadZip: (id, options) => invoke("downloadZip", id, options),
  cancelDownloads: (ids) => invoke("cancelDownloads", ids),
  listTransfers: () => invoke("listTransfers"),
  addTransfer: (url, id) => invoke("addTransfer", url, id),
  cancelTransfer: (id) => invoke("cancelTransfer", id),
  saveSettings: (patch) => invoke("saveSettings", patch),
  chooseDirectory: () => invoke("chooseDirectory"),
  openDownloadDirectory: () => invoke("openDownloadDirectory"),
  openTokenPage: () => invoke("openTokenPage"),
  addRule: (rule) => invoke("addRule", rule),
  updateRule: (id, rule) => invoke("updateRule", id, rule),
  prepareRuleDirectory: relative => invoke("prepareRuleDirectory", relative),
  removeRule: (id) => invoke("removeRule", id),
  checkRules: () => invoke("checkRules"),
  onMagnetDestination: listener => { ipcRenderer.on("magnet-destination", (_event, id: string) => listener(id)); },
  listMagnetFolders: (id, parent) => invoke("listMagnetFolders", id, parent),
  finishMagnetDestination: (id, folder) => invoke("finishMagnetDestination", id, folder),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: any) =>
      listener(state);
    ipcRenderer.on("state", handler);
    return () => ipcRenderer.removeListener("state", handler);
  },
};
contextBridge.exposeInMainWorld("putio", bridge);
