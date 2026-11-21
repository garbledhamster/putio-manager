import { interactiveSetup } from "./setup";
import { lstatSync, readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { RemoteEngine } from "../remote/client";
import { startRemoteServer } from "./server";
import { createEngine, EngineStartupFailure, QuiescentEngineOwner } from "../engine/engine";
import { CredentialAdapter } from "../core/settings";

let failedStartupOwner: QuiescentEngineOwner | undefined;
type Config = { host: string; port: number; stateDirectory: string; roots: {id:string;label:string;path:string}[]; clientTokenFile: string; credentialKeyFile: string; putioTokenFile?: string; label?: string; stagingDirectory?: string };
function absolute(p: unknown): p is string { return typeof p === "string" && path.isAbsolute(p); }
function regular(file: string, secret = false) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (secret && process.platform !== "win32" && ((st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())))) throw new Error("Credential file must be owner-only and regular.");
}
function readConfig(file: string): Config {
  if (!absolute(file)) throw new Error("Config path must be absolute.");
  regular(file);
  const c = JSON.parse(readFileSync(file, "utf8"));
  if (!c || typeof c.host !== "string" || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !absolute(c.stateDirectory) || !absolute(c.clientTokenFile) || !absolute(c.credentialKeyFile) || (c.putioTokenFile !== undefined && !absolute(c.putioTokenFile)) || (c.label !== undefined && typeof c.label !== "string") || (c.stagingDirectory !== undefined && !absolute(c.stagingDirectory)) || !Array.isArray(c.roots) || c.roots.length === 0 || c.roots.some((r: any) => !r || typeof r.id !== "string" || !r.id || typeof r.label !== "string" || !absolute(r.path))) throw new Error("Invalid server configuration.");
  return c;
}
function readSecret(file: string): string { regular(file, true); return readFileSync(file, "utf8").trim(); }
function credentialAdapter(keyFile: string): CredentialAdapter {
  const encoded = readSecret(keyFile);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Invalid credential key.");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new Error("Invalid credential key.");
  return {
    available: () => true,
    encrypt: value => {
      const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt: value => {
      if (value.length < 29) throw new Error("Invalid protected credential.");
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
async function main() {
  const args = process.argv.slice(2); const command = args.shift();
  let configFile = process.env.PUTIO_MANAGER_CONFIG;
  if (args.length === 2 && args[0] === "--config") configFile = args[1]; else if (args.length) throw new Error("Usage: server <setup|serve|status|pause|resume|auth> [--config absolute-path]");
  if (command === "setup" && configFile) { await interactiveSetup(configFile); return; }
  if (!configFile || !["serve", "status", "pause", "resume", "auth"].includes(command || "")) throw new Error("Usage: server <setup|serve|status|pause|resume|auth> [--config absolute-path]");
  const c = readConfig(configFile); const clientToken = readSecret(c.clientTokenFile);
  if (command === "serve") {
    let engine: Awaited<ReturnType<typeof createEngine>>;
    try { engine = await createEngine({ stateDirectory: c.stateDirectory, credentials: credentialAdapter(c.credentialKeyFile), label: c.label, roots: c.roots, stagingDirectory: c.stagingDirectory, token: c.putioTokenFile ? readSecret(c.putioTokenFile) : undefined }); }
    catch (error) { if (error instanceof EngineStartupFailure) { failedStartupOwner = error.owner; process.once("exit", () => { if (failedStartupOwner) process.exitCode = 1; }); } throw error; }
    let server: Awaited<ReturnType<typeof startRemoteServer>>;
    try { server = await startRemoteServer(engine, { host: c.host, port: c.port, clientToken }); } catch (error) { await engine.close(); throw error; }
    process.stdout.write("Server ready.\n");
    let closing: Promise<void> | undefined;
    const stop = () => closing ??= (async () => { try { await server.close(); } finally { await engine.close(); } })();
    const onSignal = () => { void stop().then(() => process.exit(0), () => { process.stderr.write("Could not shut down the engine cleanly.\n"); process.exit(1); }); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  } else {
    if (command === "auth" && !process.stdout.isTTY) throw new Error("Account linking requires an interactive terminal.");
    const host = c.host === "::1" ? "[::1]" : c.host;
    const client = new RemoteEngine({ url: `http://${host}:${c.port}`, token: clientToken });
    try {
      const result = command === "status" ? await client.getSnapshot() : await client.execute(command === "auth" ? "beginAccountLink" : command as "pause" | "resume");
      if (command === "auth") { const link = result as {url?: unknown; expiresAt?: unknown}; if (typeof link?.url !== "string") throw new Error("Account link unavailable."); process.stdout.write(`Open this link to authorize the account: ${link.url}\n`); }
      else process.stdout.write(JSON.stringify({ ok: true, value: result }) + "\n");
    } finally { await client.close(); }
  }
}
void main().catch(error => { if (error instanceof EngineStartupFailure) { process.stderr.write("Engine startup could not safely close a file; state ownership remains held until process exit.\n"); process.exitCode = 1; return; } process.stderr.write(process.argv[2] === "setup" ? "Setup failed. Use a new private configuration directory, an existing absolute download directory and a valid port; check permissions.\n" : "Operation failed. Check configuration, credential permissions and server availability.\n"); process.exitCode = 1; });
