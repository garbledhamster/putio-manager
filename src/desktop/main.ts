import { mkdtempSync, mkdirSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Tray, nativeImage, Menu } from "electron";
import { DesktopAdapter, integrationStatus, setStartup, setMagnet, submitMagnet, MagnetQueue } from "./platform";
import { startFixture } from "./smoke-fixture";
import { runUiScenario } from "./ui-scenario";
import { createEngine, ApplicationEngine } from "../engine/engine";
import { EngineClient, EngineCommand, EngineSnapshot } from "../engine/contracts";
import { startRemoteServer } from "../server/server";
import { RemoteEngine } from "../remote/client";
import { defaultSettings } from "../core/settings";
import { Settings, Snapshot, validateAccountLink } from "../shared";

// GUI launches may inherit a logging pipe that closes before Electron writes a warning.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

const smoke = process.argv.includes("--smoke-test");
const smokeDir = smoke ? mkdtempSync(path.join(os.tmpdir(), "putio-smoke-")) : "";
if (smoke) app.setPath("userData", smokeDir);
let window: BrowserWindow;
const integration: DesktopAdapter = {
  startupSupported: process.platform === "win32" || process.platform === "darwin",
  magnetSupported: app.isPackaged && ["win32", "darwin", "linux"].includes(process.platform),
  getStartup: () => app.getLoginItemSettings().openAtLogin,
  setStartup: enabled => app.setLoginItemSettings({ openAtLogin: enabled }),
  getMagnet: () => app.isDefaultProtocolClient("magnet"),
  setMagnet: enabled => enabled ? app.setAsDefaultProtocolClient("magnet") : app.removeAsDefaultProtocolClient("magnet"),
};
async function handleMagnet(value: string) {
  try {
    await submitMagnet(value, uri => selected().execute("addTransfer", [uri, "0"]));
    await dialog.showMessageBox(window, { type: "info", message: "Transfer added to put.io." });
    return true;
  } catch {
    await dialog.showMessageBox(window, { type: "error", message: "Could not add the magnet transfer. Check the link and selected engine connection." });
    return false;
  }
}
const magnets = new MagnetQueue(handleMagnet);

if (!smoke) {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  else {
    magnets.receive(process.argv);
    app.on("second-instance", (_event, args) => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } magnets.receive(args); });
    app.on("open-url", (event, url) => { event.preventDefault(); magnets.receive([url]); });
  }
}
let tray: Tray | undefined;
let quitting = false;
let fixtureBase: string | undefined;
let client: EngineClient | undefined;
let local: ApplicationEngine | undefined;
let unsubscribe: (() => void) | undefined;
let mode: "local" | "remote" = "local";
let config: { url: string; label: string; encryptedToken: string; mode: "local" | "remote" } = { url: "", label: "Remote", encryptedToken: "", mode: "local" };
let latest: Snapshot | undefined;
let targetUpdates: Promise<unknown> = Promise.resolve();
let targetGeneration = 0;
function updateTarget<T>(operation: () => Promise<T>): Promise<T> {
  const result = targetUpdates.catch(() => {}).then(operation);
  targetUpdates = result;
  return result;
}
// Smoke mode uses only disposable fixture credentials and a process-local key.
// Normal launches always require the operating system's secure storage.
const credentials = smoke ? (() => {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (value: string) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt: (value: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
})() : {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b),
};
const configPath = () => path.join(app.getPath("userData"), "remote-client.json");
async function saveConfig(value = config) {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
  await fs.rename(file + ".tmp", file);
}
async function loadConfig() {
  try {
    const data = JSON.parse(await fs.readFile(configPath(), "utf8"));
    if (typeof data.url !== "string" || typeof data.label !== "string" || typeof data.encryptedToken !== "string" || !["local", "remote"].includes(data.mode)) throw new Error();
    config = data;
  } catch (error: any) { if (error.code !== "ENOENT") throw new Error("Could not read remote connection settings."); }
}
const target = (status: "connected" | "connecting" | "error", message?: string) => ({ mode, label: mode === "local" ? "Local" : config.label, status, message });
function publish(value: Snapshot) {
  latest = value;
  if (window && !window.isDestroyed()) window.webContents.send("state", value);
}
function decorated(value: EngineSnapshot): Snapshot {
  return { ...value, settings: { ...value.settings, autoStartApplication: integration.startupSupported && integration.getStartup() }, target: target("connected"), account: value.connection, roots: value.roots, paused: value.paused };
}
function unavailable(message: string): Snapshot {
  return { settings: { ...defaultSettings }, hasToken: false, secureStorageAvailable: credentials.available(), rules: [], jobs: [], scanStatus: "unavailable", timeZone: "", nextRuleRuns: {}, target: target("error", message), roots: [] };
}
function bind(channel: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== window.webContents.getURL()) throw new Error("Invalid request origin.");
    return handler(...args);
  });
}
async function switchEngine(next: "local" | "remote") {
  const nextConfig = { ...config, mode: next };
  await saveConfig(nextConfig);
  targetGeneration++; config = nextConfig; mode = next;
  unsubscribe?.(); unsubscribe = undefined;
  const old = client; client = undefined; local = undefined;
  publish(unavailable(next === "remote" ? "Connecting to remote server…" : "Starting Local…"));
  if (old) {
    try { await old.close(); }
    catch { publish(unavailable("Could not close the previous engine.")); return latest!; }
  }
  try {
    if (next === "local") {
      local = await createEngine({ stateDirectory: app.getPath("userData"), credentials, apiBase: fixtureBase, label: "Local" });
      client = local;
      if (smoke) {
        const dir = path.join(smokeDir, "downloads"); mkdirSync(dir, { recursive: true }); local.allowDirectory(dir);
        await local.execute("saveSettings", [{ downloadDirectory: dir }]);
      }
    } else {
      if (!config.url || !config.encryptedToken) throw new Error("Configure the server address and client credential in Settings.");
      if (!credentials.available()) throw new Error("Secure storage is unavailable for the remote server credential.");
      let token: string;
      try { token = credentials.decrypt(Buffer.from(config.encryptedToken, "base64")); } catch { throw new Error("Could not unlock the remote server credential."); }
      client = new RemoteEngine({ url: config.url, token });
    }
    const selected = client;
    unsubscribe = selected.subscribe(s => { if (client === selected) publish(decorated(s)); }, e => { if (client === selected) publish(unavailable(e.message)); });
    try { const s = await selected.getSnapshot(); if (client === selected) publish(decorated(s)); }
    catch (e) { if (client === selected) publish(unavailable(e instanceof Error ? e.message : "Connection failed.")); }
  } catch (e) { publish(unavailable(e instanceof Error ? e.message : "Connection failed.")); }
  return latest!;
}
function selected(): EngineClient { if (!client) throw new Error("The selected engine is unavailable. Check Settings."); return client; }
function captureTarget() { return { engine: selected(), generation: targetGeneration }; }
function assertTarget(target: { engine: EngineClient; generation: number }) {
  if (client !== target.engine || targetGeneration !== target.generation) throw new Error("Engine selection changed. Try again.");
}
async function state() {
  let context: ReturnType<typeof captureTarget>;
  try { context = captureTarget(); } catch (e) { return unavailable(e instanceof Error ? e.message : "Connection failed."); }
  try { const snapshot = await context.engine.getSnapshot(); assertTarget(context); return decorated(snapshot); }
  catch (e) { assertTarget(context); return unavailable(e instanceof Error ? e.message : "Connection failed."); }
}
async function command(command: EngineCommand, args: unknown[] = []) { return selected().execute(command, args, ["downloadFile", "downloadZip", "retryDownload"].includes(command) ? randomUUID() : undefined); }
async function configureRemote(input: {url: string; label: string; token?: string}) {
    if (!input || typeof input.url !== "string" || typeof input.label !== "string" || input.label.length > 80 || (input.token !== undefined && typeof input.token !== "string")) throw new Error("Invalid remote configuration.");
    let url: URL; try { url = new URL(input.url); } catch { throw new Error("Invalid remote endpoint."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Invalid remote endpoint.");
    let encryptedToken = config.encryptedToken;
    if (input.token) {
      if (!/^[A-Za-z0-9_-]{43,256}$/.test(input.token)) throw new Error("Invalid client credential.");
      if (!credentials.available()) throw new Error("Secure storage is unavailable; cannot save the client credential.");
      encryptedToken = credentials.encrypt(input.token).toString("base64");
    }
    const nextConfig = { ...config, url: url.origin, label: input.label.trim() || "Remote", encryptedToken }; await saveConfig(nextConfig); targetGeneration++; config = nextConfig;
    return { url: config.url, label: config.label, hasCredential: !!config.encryptedToken };
}
function bindHandlers() {
  bind("getState", state);
  bind("getDesktopIntegration", () => integrationStatus(integration));
  bind("setMagnetRegistration", (enabled: unknown) => { if (typeof enabled !== "boolean") throw new Error("Invalid magnet registration choice."); return setMagnet(integration, enabled); });
  bind("getRemoteConnection", () => ({ url: config.url, label: config.label, hasCredential: !!config.encryptedToken }));
  bind("configureRemote", (input: {url: string; label: string; token?: string}) => updateTarget(async () => {
    const result = await configureRemote(input);
    if (mode === "remote") await switchEngine("remote");
    return result;
  }));
  bind("selectEngine", async (next: unknown) => { if (next !== "local" && next !== "remote") throw new Error("Invalid engine."); return updateTarget(() => switchEngine(next)); });
  bind("connectAccount", async () => {
    const context = captureTarget(); const engine = context.engine;
    const link = await engine.execute("beginAccountLink") as { url: string; expiresAt: string };
    try { assertTarget(context); } catch (error) { await engine.execute("cancelAccountLink").catch(() => {}); throw error; }
    try { await shell.openExternal(validateAccountLink(link.url)); }
    catch { await engine.execute("cancelAccountLink"); throw new Error("Could not open the account link."); }
    const deadline = Date.parse(link.expiresAt);
    while (Date.now() < deadline) {
      assertTarget(context);
      const snap = await engine.getSnapshot();
      assertTarget(context);
      if (snap.connection.status === "connected") return decorated(snap);
      if (snap.connection.status === "error") throw new Error(snap.connection.message || "Account connection failed.");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await engine.execute("cancelAccountLink"); throw new Error("Account connection expired.");
  });
  for (const name of ["listFiles", "renameFile", "createFolder", "deleteFile", "downloadFile", "downloadZip", "cancelDownloads", "listTransfers", "addTransfer", "cancelTransfer", "addRule", "updateRule", "prepareRuleDirectory", "removeRule", "checkRules", "pause", "resume", "retryDownload"] as EngineCommand[]) bind(name, (...args) => command(name, args.filter((arg, index) => arg !== undefined || index < args.length - 1)));
  bind("saveSettings", async (patch: Partial<Settings> & {token?: string}) => {
    if (mode === "remote" && patch?.token) throw new Error("Use Connect with put.io to authorize the remote server.");
    const context = captureTarget();
    const { autoStartApplication, ...enginePatch } = patch;
    const previousStartup = integration.startupSupported && integration.getStartup();
    if (autoStartApplication !== undefined) {
      if (typeof autoStartApplication !== "boolean") throw new Error("Invalid login startup setting.");
      setStartup(integration, autoStartApplication);
    }
    try {
      const result = Object.keys(enginePatch).length ? await context.engine.execute("saveSettings", [enginePatch]) as EngineSnapshot : await context.engine.getSnapshot();
      assertTarget(context); return decorated(result);
    } catch (error) {
      if (autoStartApplication !== undefined) { try { setStartup(integration, previousStartup); } catch {} }
      throw error;
    }
  });
  bind("selectDownloadRoot", async (id: string, relative?: string) => {
    const context = captureTarget();
    const result = await context.engine.execute("selectDownloadRoot", relative === undefined ? [id] : [id, relative]) as EngineSnapshot;
    assertTarget(context); return decorated(result);
  });
  bind("chooseDirectory", async () => {
    if (mode !== "local" || !local) throw new Error("Choose a configured remote server root in Settings.");
    const context = captureTarget(); const localEngine = local;
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    assertTarget(context);
    const chosen = result.canceled ? null : (result.filePaths[0] ?? null); if (chosen) localEngine.allowDirectory(chosen); return chosen;
  });
  bind("openDownloadDirectory", async () => {
    if (mode !== "local") throw new Error("Remote server folders cannot be opened on this computer.");
    const context = captureTarget();
    const dir = (await context.engine.getSnapshot()).settings.downloadDirectory;
    assertTarget(context);
    if (!dir) throw new Error("Choose a download directory first.");
    if (await shell.openPath(dir)) throw new Error("Could not open the download directory.");
  });
  bind("openTokenPage", () => shell.openExternal("https://app.put.io/settings/account"));
}
app.whenReady().then(async () => {
  if (process.argv.includes("--verify-startup")) {
    if (!app.isPackaged || !integration.startupSupported) throw new Error("Native startup verification requires a supported packaged application.");
    const previous = integration.getStartup();
    try { setStartup(integration, true); setStartup(integration, false); }
    finally { setStartup(integration, previous); }
    console.log("NATIVE STARTUP VERIFIED; previous preference restored."); app.exit(0); return;
  }
  const fixture = smoke ? await startFixture() : undefined; fixtureBase = fixture?.base;
  await loadConfig();
  const bootstrap = process.argv.find(arg => arg.startsWith("--configure-remote="));
  if (bootstrap) {
    const file = bootstrap.slice("--configure-remote=".length);
    if (!path.isAbsolute(file)) throw new Error("Remote bootstrap path must be absolute.");
    try {
      const input = JSON.parse(await fs.readFile(file, "utf8"));
      if (!input || typeof input.token !== "string" || !input.token) throw new Error();
      await configureRemote(input);
      await fs.unlink(file);
    } catch { throw new Error("Could not apply remote bootstrap configuration."); }
    console.log("REMOTE CONFIGURED"); app.quit(); return;
  }
  bindHandlers();
  const icon = nativeImage.createFromPath(path.join(__dirname, "../ui/branding/putio-manager.png"));
  if (icon.isEmpty()) throw new Error("Application icon is unavailable.");
  window = new BrowserWindow({ width: 892, height: 510, icon, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("minimize", () => { if (tray) window.hide(); });
  window.on("close", () => { quitting = true; });
  await switchEngine(config.mode);
  await window.loadFile(path.join(__dirname, "../ui/index.html"));
  magnets.start();
  if (!icon.isEmpty()) { tray = new Tray(icon.resize({ width: 16, height: 16 })); tray.setContextMenu(Menu.buildFromTemplate([{ label: "Show", click: () => window.show() }, { label: "Quit", click: () => app.quit() }])); tray.setToolTip("Putio Manager"); tray.on("double-click", () => window.show()); }
  if (smoke) {
    const remoteDir = path.join(smokeDir, "remote-state"), rootDir = path.join(smokeDir, "remote-downloads");
    mkdirSync(rootDir, { recursive: true });
    const remoteFixture = await createEngine({ stateDirectory: remoteDir, credentials, apiBase: fixtureBase, roots: [{ id: "fixture", label: "Fixture root", path: rootDir }], token: "fixture-token", label: "Fixture server" });
    const fixtureToken = randomBytes(32).toString("base64url");
    const delayedFixture: EngineClient = {
      getSnapshot: async () => { await new Promise(resolve => setTimeout(resolve, 600)); return remoteFixture.getSnapshot(); },
      execute: (command, args, requestId) => remoteFixture.execute(command, args, requestId),
      subscribe: (listener, onError) => remoteFixture.subscribe(listener, onError),
      close: () => remoteFixture.close(),
    };
    const server = await startRemoteServer(delayedFixture, { host: "127.0.0.1", port: 0, clientToken: fixtureToken });
    const address = server.address;
    if (!address || typeof address === "string") throw new Error("Fixture server address unavailable.");
    await runUiScenario(window, { url: `http://127.0.0.1:${address.port}`, token: fixtureToken });
    await server.close(); await remoteFixture.close(); const arg = process.argv.find(v => v.startsWith("--screenshot=")); if (arg) await fs.writeFile(arg.slice(13), (await window.webContents.capturePage()).toPNG()); console.log("SMOKE PASS"); fixture?.server.close(); app.quit(); }
}).catch(error => { console.error("Startup or smoke test failed:", error.message); app.exit(1); });
app.on("activate", () => { if (window && !window.isDestroyed()) window.show(); });
let closing = false;
app.on("before-quit", event => { quitting = true; if (!closing && client) { event.preventDefault(); closing = true; unsubscribe?.(); void client.close().finally(() => app.quit()); } });
app.on("window-all-closed", () => { if (quitting || process.platform !== "darwin") app.quit(); });
