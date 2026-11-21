import { mkdirSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";

export function createSetup(configFile: string, root: string, port: number) {
  if (!path.isAbsolute(configFile) || !path.isAbsolute(root) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter absolute paths and a valid port.");
  if (!statSync(root).isDirectory()) throw new Error("The download root must be an existing directory.");
  const dir = path.dirname(configFile);
  // A new private directory ensures setup never overwrites an existing installation.
  mkdirSync(dir, { mode: 0o700 });
  if (process.platform === "win32") {
    // USERNAME can name a different account (for example in a sandbox or service).
    // Resolve the executing identity's SID, which is unambiguous and locale-independent.
    let sid: string | undefined;
    try {
      sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      }).match(/,"(S-\d+(?:-\d+)+)"\s*$/m)?.[1];
    } catch { /* Fail before writing credentials when the identity is unavailable. */ }
    if (!sid) throw new Error("Cannot determine the Windows account for private setup.");
    execFileSync("icacls.exe", [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
  } else chmodSync(dir, 0o700);
  const clientTokenFile = path.join(dir, "client-token"), credentialKeyFile = path.join(dir, "credential-key");
  for (const file of [clientTokenFile, credentialKeyFile]) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  const config = { host: "127.0.0.1", port, stateDirectory: path.join(dir, "state"), roots: [{ id: "downloads", label: "Downloads", path: root }], clientTokenFile, credentialKeyFile };
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
}
export async function interactiveSetup(configFile: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup requires an interactive terminal.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("Headless setup: downloads are stored on this server. The config directory must be new.\n");
    const root = (await prompt.question("Existing absolute download directory: ")).trim();
    const portText = (await prompt.question("Loopback port [5173]: ")).trim();
    createSetup(configFile, root, portText ? Number(portText) : 5173);
    process.stdout.write("Setup complete. Start serve with this config, then run auth in another terminal to connect put.io. Use a service supervisor to restart serve after reboot. Protect the client credential and key; do not publish them.\n");
  } finally { prompt.close(); }
}
